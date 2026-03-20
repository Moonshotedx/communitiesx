import { z } from 'zod';
import { router, publicProcedure, authProcedure } from '../trpc';
import { db } from '@/server/db';
import {
    chatThreads,
    directMessages,
    users,
    pushSubscriptions,
    notifications,
} from '@/server/db/schema';
import { TRPCError } from '@trpc/server';
import {
    eq,
    and,
    or,
    desc,
    gt,
    sql,
    asc,
    lt,
    count,
    inArray,
} from 'drizzle-orm';

import { sendChatNotification } from '@/lib/push-notifications';

export const chatRouter = router({
    // Get all chat threads for the current user
    getThreads: authProcedure.query(async ({ ctx }) => {
        try {
            const userId = ctx.session.user.id;

            // Get all threads where the current user is involved
            const threads = await db.query.chatThreads.findMany({
                where: or(
                    eq(chatThreads.user1Id, userId),
                    eq(chatThreads.user2Id, userId),
                ),
                orderBy: desc(chatThreads.lastMessageAt),
                with: {
                    user1: {
                        columns: {
                            id: true,
                            name: true,
                            email: true,
                            image: true,
                        },
                    },
                    user2: {
                        columns: {
                            id: true,
                            name: true,
                            email: true,
                            image: true,
                        },
                    },
                },
            });

            // Get unread message counts in a single aggregated query
            const threadIds = threads.map((t) => t.id);
            const unreadCountMap: Record<number, number> = {};

            if (threadIds.length > 0) {
                const unreadCounts = await db
                    .select({
                        threadId: directMessages.threadId,
                        count: sql<number>`count(*)`,
                    })
                    .from(directMessages)
                    .where(
                        and(
                            inArray(directMessages.threadId, threadIds),
                            eq(directMessages.recipientId, userId),
                            eq(directMessages.isRead, false),
                        ),
                    )
                    .groupBy(directMessages.threadId);

                for (const row of unreadCounts) {
                    unreadCountMap[row.threadId] = row.count;
                }
            }

            const threadsWithUnreadCounts = threads.map((thread) => {
                const otherUser =
                    thread.user1Id === userId ? thread.user2 : thread.user1;
                return {
                    ...thread,
                    unreadCount: unreadCountMap[thread.id] ?? 0,
                    otherUser,
                };
            });

            return threadsWithUnreadCounts;
        } catch (error) {
            console.error('Error fetching chat threads:', error);
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to fetch chat threads',
            });
        }
    }),

    // Get messages for a specific thread
    getMessages: authProcedure
        .input(
            z.object({
                threadId: z.number(),
                limit: z.number().optional().default(50),
                cursor: z.number().optional(), // For pagination
            }),
        )
        .query(async ({ input, ctx }) => {
            try {
                const userId = ctx.session.user.id;

                // Check if user is part of the thread
                const thread = await db.query.chatThreads.findFirst({
                    where: and(
                        eq(chatThreads.id, input.threadId),
                        or(
                            eq(chatThreads.user1Id, userId),
                            eq(chatThreads.user2Id, userId),
                        ),
                    ),
                });

                if (!thread) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message: 'You do not have access to this chat thread',
                    });
                }

                // Get messages with pagination
                let whereClause: any = eq(
                    directMessages.threadId,
                    input.threadId,
                );
                if (input.cursor !== undefined && input.cursor !== null) {
                    whereClause = and(
                        eq(directMessages.threadId, input.threadId),
                        lt(directMessages.id, input.cursor), // Fetch older messages
                    );
                }
                let messages = await db.query.directMessages.findMany({
                    where: whereClause,
                    orderBy: desc(directMessages.createdAt), // LATEST messages first
                    limit: input.limit,
                    with: {
                        sender: {
                            columns: {
                                id: true,
                                name: true,
                                email: true,
                                image: true,
                            },
                        },
                    },
                });
                // Reverse so newest is at the bottom
                messages = messages.slice().reverse();

                // Mark messages as read
                await db
                    .update(directMessages)
                    .set({ isRead: true })
                    .where(
                        and(
                            eq(directMessages.threadId, input.threadId),
                            eq(directMessages.recipientId, userId),
                            eq(directMessages.isRead, false),
                        ),
                    );

                // Get the next cursor
                const nextCursor =
                    messages.length > 0
                        ? messages[0].id // The oldest message id in this batch
                        : null;

                return {
                    messages,
                    nextCursor,
                };
            } catch (error) {
                console.error('Error fetching messages:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to fetch messages',
                });
            }
        }),

    sendMessage: authProcedure
        .input(
            z.object({
                recipientId: z.string(),
                content: z.string().min(1).max(2000),
                threadId: z.number().optional(), // Optional if creating a new thread
            }),
        )
        .mutation(async ({ input, ctx }) => {
            try {
                const senderId = ctx.session.user.id;

                // Get sender's org
                const sender = await db.query.users.findFirst({
                    where: eq(users.id, senderId),
                });

                if (!sender?.orgId) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'User does not belong to an organization',
                    });
                }

                // Check if recipient exists and is in the same org
                const recipient = await db.query.users.findFirst({
                    where: eq(users.id, input.recipientId),
                });

                if (!recipient) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Recipient not found',
                    });
                }

                if (recipient.orgId !== sender.orgId) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message:
                            'You can only message users in your organization',
                    });
                }

                let threadId = input.threadId;

                // If no threadId provided, find existing thread or create new one
                if (!threadId) {
                    // Check if thread already exists between these users
                    const existingThread = await db.query.chatThreads.findFirst(
                        {
                            where: or(
                                and(
                                    eq(chatThreads.user1Id, senderId),
                                    eq(chatThreads.user2Id, input.recipientId),
                                ),
                                and(
                                    eq(chatThreads.user1Id, input.recipientId),
                                    eq(chatThreads.user2Id, senderId),
                                ),
                            ),
                        },
                    );

                    if (existingThread) {
                        threadId = existingThread.id;
                    } else {
                        // Create new thread
                        const [newThread] = await db
                            .insert(chatThreads)
                            .values({
                                user1Id: senderId,
                                user2Id: input.recipientId,
                                orgId: sender.orgId,
                                lastMessageAt: new Date(),
                                lastMessagePreview: input.content.substring(
                                    0,
                                    50,
                                ),
                                createdAt: new Date(),
                            })
                            .returning();

                        threadId = newThread.id;
                    }
                }

                // Send the message
                const [message] = await db
                    .insert(directMessages)
                    .values({
                        threadId,
                        senderId,
                        recipientId: input.recipientId,
                        content: input.content,
                        createdAt: new Date(),
                    })
                    .returning();

                // Update the thread's last message info
                await db
                    .update(chatThreads)
                    .set({
                        lastMessageAt: new Date(),
                        lastMessagePreview: input.content.substring(0, 50),
                    })
                    .where(eq(chatThreads.id, threadId));

                // Get recipient's push subscription
                // const recipientSubscription = await db
                //     .select()
                //     .from(pushSubscriptions)
                //     .where(eq(pushSubscriptions.userId, input.recipientId))
                //     .limit(1);
                const recipientSubscriptions = await db
                    .select({
                        endpoint: pushSubscriptions.endpoint,
                        p256dh: pushSubscriptions.p256dh,
                        auth: pushSubscriptions.auth,
                    })
                    .from(pushSubscriptions)
                    .where(eq(pushSubscriptions.userId, input.recipientId));

                // Send push notification if recipient is subscribed
                if (recipientSubscriptions.length > 0) {
                    const senderName = sender?.name || 'Someone';

                    try {
                        await sendChatNotification(
                            recipientSubscriptions,
                            senderName,
                            input.content,
                            threadId.toString(),
                        );

                        // Save notification to database
                        await db.insert(notifications).values({
                            recipientId: input.recipientId,
                            title: `New message from ${senderName}`,
                            body:
                                input.content.length > 100
                                    ? input.content.substring(0, 100) + '...'
                                    : input.content,
                            type: 'dm',
                            data: JSON.stringify({
                                threadId: threadId,
                                messageId: message.id,
                                senderId: senderId,
                            }),
                        });
                    } catch (error) {
                        console.error(
                            'Error sending push notification:',
                            error,
                        );
                        throw new TRPCError({
                            code: 'INTERNAL_SERVER_ERROR',
                            message: 'Failed to send push notification',
                        });
                    }
                }

                // Get the message with sender info
                const messageWithSender =
                    await db.query.directMessages.findFirst({
                        where: eq(directMessages.id, message.id),
                        with: {
                            sender: {
                                columns: {
                                    id: true,
                                    name: true,
                                    email: true,
                                    image: true,
                                },
                            },
                        },
                    });

                return {
                    message: messageWithSender,
                    threadId,
                    notificationsSent: recipientSubscriptions.length, // Added to match Claude's version
                };
            } catch (error) {
                console.error('Error sending message:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to send message',
                });
            }
        }),

    // Get new messages since a specific timestamp (for polling)
    getNewMessages: authProcedure
        .input(
            z.object({
                threadId: z.number(),
                since: z.date(),
            }),
        )
        .query(async ({ input, ctx }) => {
            try {
                const userId = ctx.session.user.id;

                // Check if user is part of the thread
                const thread = await db.query.chatThreads.findFirst({
                    where: and(
                        eq(chatThreads.id, input.threadId),
                        or(
                            eq(chatThreads.user1Id, userId),
                            eq(chatThreads.user2Id, userId),
                        ),
                    ),
                });

                if (!thread) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message: 'You do not have access to this chat thread',
                    });
                }

                // Get new messages since the specified timestamp
                const newMessages = await db.query.directMessages.findMany({
                    where: and(
                        eq(directMessages.threadId, input.threadId),
                        gt(directMessages.createdAt, input.since),
                    ),
                    orderBy: asc(directMessages.createdAt),
                    with: {
                        sender: {
                            columns: {
                                id: true,
                                name: true,
                                email: true,
                                image: true,
                            },
                        },
                    },
                });

                // Mark messages as read if the current user is the recipient
                await db
                    .update(directMessages)
                    .set({ isRead: true })
                    .where(
                        and(
                            eq(directMessages.threadId, input.threadId),
                            eq(directMessages.recipientId, userId),
                            eq(directMessages.isRead, false),
                        ),
                    );

                return newMessages;
            } catch (error) {
                console.error('Error fetching new messages:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to fetch new messages',
                });
            }
        }),

    // Get total unread message count
    getUnreadCount: publicProcedure.query(async ({ ctx }) => {
        if (!ctx.session?.user) {
            throw new TRPCError({
                code: 'UNAUTHORIZED',
                message: 'You must be logged in to view unread count',
            });
        }

        try {
            const userId = ctx.session.user.id;

            const result = await db
                .select({ count: sql<number>`count(*)` })
                .from(directMessages)
                .where(
                    and(
                        eq(directMessages.recipientId, userId),
                        eq(directMessages.isRead, false),
                    ),
                );

            return result[0]?.count || 0;
        } catch (error) {
            console.error('Error fetching unread count:', error);
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to fetch unread count',
            });
        }
    }),

    // Get users in the same org for starting new conversations
    getOrgUsers: authProcedure.query(async ({ ctx }) => {
        try {
            const userId = ctx.session.user.id;

            // Get user's org
            const user = await db.query.users.findFirst({
                where: eq(users.id, userId),
            });

            if (!user?.orgId) {
                throw new TRPCError({
                    code: 'BAD_REQUEST',
                    message: 'User does not belong to an organization',
                });
            }

            // Get all users in the same org except the current user
            const orgUsers = await db.query.users.findMany({
                where: and(
                    eq(users.orgId, user.orgId),
                    sql`${users.id} != ${userId}`,
                ),
                columns: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                },
            });

            return orgUsers;
        } catch (error) {
            console.error('Error fetching org users:', error);
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to fetch org users',
            });
        }
    }),

    // Find an existing thread or create a new one
    findOrCreateThread: authProcedure
        .input(
            z.object({
                recipientId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            try {
                const senderId = ctx.session.user.id;

                if (senderId === input.recipientId) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'Cannot create a chat thread with yourself',
                    });
                }

                // Get sender's org
                const sender = await db.query.users.findFirst({
                    where: eq(users.id, senderId),
                });

                if (!sender?.orgId) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'User does not belong to an organization',
                    });
                }

                // Check if recipient exists and is in the same org
                const recipient = await db.query.users.findFirst({
                    where: eq(users.id, input.recipientId),
                });

                if (!recipient) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Recipient not found',
                    });
                }

                if (recipient.orgId !== sender.orgId) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message:
                            'You can only message users in your organization',
                    });
                }

                // Check if thread already exists between these users
                const existingThread = await db.query.chatThreads.findFirst({
                    where: or(
                        and(
                            eq(chatThreads.user1Id, senderId),
                            eq(chatThreads.user2Id, input.recipientId),
                        ),
                        and(
                            eq(chatThreads.user1Id, input.recipientId),
                            eq(chatThreads.user2Id, senderId),
                        ),
                    ),
                });

                if (existingThread) {
                    return { threadId: existingThread.id, isNew: false };
                }

                // Create new thread
                const [newThread] = await db
                    .insert(chatThreads)
                    .values({
                        user1Id: senderId,
                        user2Id: input.recipientId,
                        orgId: sender.orgId,
                        lastMessageAt: new Date(),
                        lastMessagePreview: 'New conversation',
                        createdAt: new Date(),
                    })
                    .returning();

                return { threadId: newThread.id, isNew: true };
            } catch (error) {
                console.error('Error finding or creating thread:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to find or create chat thread',
                });
            }
        }),

    // Get thread by ID
    getThreadById: authProcedure
        .input(
            z.object({
                threadId: z.number(),
            }),
        )
        .query(async ({ input, ctx }) => {
            try {
                const userId = ctx.session.user.id;

                // Check if user is part of the thread
                const thread = await db.query.chatThreads.findFirst({
                    where: and(
                        eq(chatThreads.id, input.threadId),
                        or(
                            eq(chatThreads.user1Id, userId),
                            eq(chatThreads.user2Id, userId),
                        ),
                    ),
                    columns: {
                        id: true,
                        user1Id: true,
                        user2Id: true,
                        orgId: true,
                        createdAt: true,
                        lastMessageAt: true,
                    },
                    with: {
                        user1: {
                            columns: {
                                id: true,
                                name: true,
                                email: true,
                                image: true,
                            },
                        },
                        user2: {
                            columns: {
                                id: true,
                                name: true,
                                email: true,
                                image: true,
                            },
                        },
                    },
                });

                if (!thread) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message: 'You do not have access to this chat thread',
                    });
                }

                return thread;
            } catch (error) {
                console.error('Error fetching thread details:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to fetch thread details',
                });
            }
        }),

    // Subscribe to push notifications
    subscribeToPush: authProcedure
        .input(
            z.object({
                endpoint: z.string(),
                p256dh: z.string(),
                auth: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            try {
                // Check if subscription already exists
                const existingSubscription =
                    await db.query.pushSubscriptions.findFirst({
                        where: eq(
                            pushSubscriptions.userId,
                            ctx.session.user.id,
                        ),
                    });

                if (existingSubscription) {
                    // Update existing subscription
                    await db
                        .update(pushSubscriptions)
                        .set({
                            endpoint: input.endpoint,
                            p256dh: input.p256dh,
                            auth: input.auth,
                            updatedAt: new Date(),
                        })
                        .where(
                            eq(pushSubscriptions.userId, ctx.session.user.id),
                        );
                } else {
                    // Create new subscription
                    await db.insert(pushSubscriptions).values({
                        userId: ctx.session.user.id,
                        endpoint: input.endpoint,
                        p256dh: input.p256dh,
                        auth: input.auth,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    });
                }

                return { success: true };
            } catch (error) {
                console.error(
                    'Error subscribing to push notifications:',
                    error,
                );
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to subscribe to notifications',
                });
            }
        }),

    // Unsubscribe from push notifications
    unsubscribeFromPush: authProcedure.mutation(async ({ ctx }) => {
        try {
            await db
                .delete(pushSubscriptions)
                .where(eq(pushSubscriptions.userId, ctx.session.user.id));

            return { success: true };
        } catch (error) {
            console.error(
                'Error unsubscribing from push notifications:',
                error,
            );
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to unsubscribe from notifications',
            });
        }
    }),

    // Check subscription status
    getSubscriptionStatus: publicProcedure.query(async ({ ctx }) => {
        if (!ctx.session?.user) {
            return { isSubscribed: false };
        }

        try {
            const subscription = await db.query.pushSubscriptions.findFirst({
                where: eq(pushSubscriptions.userId, ctx.session.user.id),
            });

            return { isSubscribed: !!subscription };
        } catch (error) {
            console.error('Error checking subscription status:', error);
            return { isSubscribed: false };
        }
    }),

    // Get notifications for the current user with pagination
    getNotifications: authProcedure
        .input(
            z.object({
                limit: z.number().default(5),
                cursor: z.number().optional(), // notification ID for cursor-based pagination
            }),
        )
        .query(async ({ ctx, input }) => {
            const whereConditions = [
                eq(notifications.recipientId, ctx.session.user.id),
            ];

            // Add cursor condition if provided
            if (input.cursor) {
                whereConditions.push(lt(notifications.id, input.cursor));
            }

            const notificationsList = await db
                .select({
                    id: notifications.id,
                    title: notifications.title,
                    body: notifications.body,
                    type: notifications.type,
                    data: notifications.data,
                    isRead: notifications.isRead,
                    createdAt: notifications.createdAt,
                })
                .from(notifications)
                .where(and(...whereConditions))
                .orderBy(desc(notifications.createdAt), desc(notifications.id))
                .limit(input.limit + 1); // Get one extra to check if there are more

            let nextCursor: number | undefined = undefined;
            if (notificationsList.length > input.limit) {
                const nextItem = notificationsList.pop(); // Remove the extra item
                nextCursor = nextItem!.id;
            }

            return {
                notifications: notificationsList,
                nextCursor,
            };
        }),

    // Get unread notifications count
    getUnreadNotificationsCount: authProcedure.query(async ({ ctx }) => {
        const [result] = await db
            .select({ count: count() })
            .from(notifications)
            .where(
                and(
                    eq(notifications.recipientId, ctx.session.user.id),
                    eq(notifications.isRead, false),
                ),
            );

        return result?.count || 0;
    }),

    // Mark notifications as read
    markNotificationsAsRead: authProcedure
        .input(
            z.object({
                notificationIds: z.array(z.number()).optional(), // If not provided, mark all as read
            }),
        )
        .mutation(async ({ ctx, input }) => {
            const whereConditions = [
                eq(notifications.recipientId, ctx.session.user.id),
            ];

            if (input.notificationIds && input.notificationIds.length > 0) {
                whereConditions.push(
                    inArray(notifications.id, input.notificationIds),
                );
            }

            await db
                .update(notifications)
                .set({
                    isRead: true,
                    updatedAt: new Date(),
                })
                .where(and(...whereConditions));

            return { success: true };
        }),

    // Mark single notification as read
    markNotificationAsRead: authProcedure
        .input(
            z.object({
                notificationId: z.number(),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            await db
                .update(notifications)
                .set({
                    isRead: true,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(notifications.id, input.notificationId),
                        eq(notifications.recipientId, ctx.session.user.id),
                    ),
                );

            return { success: true };
        }),

    // Delete notification
    deleteNotification: authProcedure
        .input(
            z.object({
                notificationId: z.number(),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            await db
                .delete(notifications)
                .where(
                    and(
                        eq(notifications.id, input.notificationId),
                        eq(notifications.recipientId, ctx.session.user.id),
                    ),
                );

            return { success: true };
        }),
});
