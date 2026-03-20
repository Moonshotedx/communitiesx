import { z } from 'zod';
import { authProcedure } from '../trpc';
import { db } from '@/server/db';
import { TRPCError } from '@trpc/server';
import {
    posts,
    users,
    communities,
    communityMembers,
    tags,
    postTags,
    attachments,
    polls,
    pollOptions,
    pollVotes,
} from '@/server/db/schema';
import { and, eq, isNull, gte, inArray } from 'drizzle-orm';
import { ServerPermissions } from '@/server/utils/permission';
import { PERMISSIONS } from '@/lib/permissions/permission-const';
import { isOrgAdminForCommunity } from '@/lib/utils';
import {
    sendCommunityPostNotification,
    saveCommunityPostNotifications,
} from '@/lib/community-notifications';

export const postProcedures = {
    // Create a new post
    createPost: authProcedure
        .input(
            z
                .object({
                    title: z.string().min(1).max(200).optional(),
                    content: z.string().max(50000),
                    communityId: z.number().nullable().optional(),
                    orgId: z.string().optional().nullable(),
                    tagIds: z.array(z.number()).optional(),
                    poll: z
                        .object({
                            question: z.string().min(1).max(200),
                            pollType: z.enum(['single', 'multiple']),
                            options: z
                                .array(z.string().min(1).max(100))
                                .min(2)
                                .max(10),
                            expiresAt: z.date().optional(),
                        })
                        .optional(),
                    qa: z
                        .object({
                            answersVisibleAt: z.date().optional(),
                            allowEditsUntil: z.date().optional(),
                        })
                        .optional(),
                })
                .refine(
                    (data) => {
                        // Either title or poll must be provided
                        return data.title || data.poll;
                    },
                    {
                        message: 'Either title or poll must be provided',
                    },
                ),
        )
        .mutation(async ({ input, ctx }) => {
            try {
                // Always fetch user details from DB
                const user = await db.query.users.findFirst({
                    where: eq(users.id, ctx.session?.user?.id ?? ''),
                });

                if (!user) {
                    throw new TRPCError({
                        code: 'UNAUTHORIZED',
                        message: 'User not found.',
                    });
                }

                // Super admins don't need an orgId
                const isSuperAdmin = user.appRole === 'admin';
                const orgId = user.orgId;

                if (!isSuperAdmin && !orgId) {
                    throw new TRPCError({
                        code: 'UNAUTHORIZED',
                        message: 'User does not have an organization.',
                    });
                }

                // If communityId is provided, verify the community exists and user has access
                if (input.communityId) {
                    const community = await db.query.communities.findFirst({
                        where: eq(communities.id, input.communityId),
                        with: {
                            members: {
                                where: eq(
                                    communityMembers.userId,
                                    ctx.session?.user?.id ?? '',
                                ),
                            },
                        },
                    });

                    if (!community) {
                        throw new TRPCError({
                            code: 'NOT_FOUND',
                            message: 'Community not found',
                        });
                    }

                    // Check if user is a member, regardless of community type
                    const userMembership = community.members.find(
                        (m) =>
                            m.membershipType === 'member' &&
                            m.status === 'active',
                    );

                    // --- PERMISSION OVERRIDES ---
                    // Check if user is org admin for this community
                    const isOrgAdminForCommunityCheck = isOrgAdminForCommunity(
                        { role: user.role, orgId: user.orgId },
                        community.orgId,
                    );

                    // Super admins can create posts in ANY community across all organizations
                    // Org admins can create posts in ANY community within their organization
                    if (isSuperAdmin) {
                        // Super admin can create posts anywhere - skip all checks
                    } else if (isOrgAdminForCommunityCheck) {
                        // Org admin can create posts in their org's communities - skip membership check
                    } else if (!userMembership) {
                        throw new TRPCError({
                            code: 'FORBIDDEN',
                            message:
                                'You must be a member to post in this community',
                        });
                    }

                    // Check if user's role meets the minimum requirement for post creation
                    // Super admins and org admins bypass role hierarchy checks
                    if (!isSuperAdmin && !isOrgAdminForCommunityCheck) {
                        const userRole = userMembership?.role || 'member';
                        const minRole = community.postCreationMinRole;

                        // Define role hierarchy (higher number = higher privilege)
                        const roleHierarchy = {
                            member: 1,
                            moderator: 2,
                            admin: 3,
                        };

                        const userRoleLevel =
                            roleHierarchy[
                                userRole as keyof typeof roleHierarchy
                            ] || 0;
                        const minRoleLevel =
                            roleHierarchy[
                                minRole as keyof typeof roleHierarchy
                            ] || 1;

                        if (userRoleLevel < minRoleLevel) {
                            const roleDisplay = {
                                member: 'members',
                                moderator: 'moderators and admins',
                                admin: 'admins',
                            };

                            throw new TRPCError({
                                code: 'FORBIDDEN',
                                message: `Only ${roleDisplay[minRole as keyof typeof roleDisplay]} can create posts in this community`,
                            });
                        }
                    }

                    // If tagIds are provided, verify they belong to the community
                    if (input.tagIds && input.tagIds.length > 0) {
                        const communityTags = await db.query.tags.findMany({
                            where: and(
                                eq(tags.communityId, input.communityId),
                                inArray(tags.id, input.tagIds),
                            ),
                        });

                        if (communityTags.length !== input.tagIds.length) {
                            throw new TRPCError({
                                code: 'BAD_REQUEST',
                                message:
                                    'Some tags do not belong to this community',
                            });
                        }
                    }
                }

                // Determine if there are any recent, unlinked attachments from this user
                const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
                const baseAttachmentConds = [
                    eq(attachments.uploadedBy, ctx.session?.user?.id ?? ''),
                    isNull(attachments.postId),
                    gte(attachments.createdAt, oneHourAgo),
                ];
                if (input.communityId) {
                    baseAttachmentConds.push(
                        eq(attachments.communityId, input.communityId),
                    );
                }
                const pendingAttachments = await db.query.attachments.findMany({
                    where: and(...baseAttachmentConds),
                });

                // Allow media-only posts if there are pending attachments
                // Also allow polls without content
                const textOnlyContent = (input.content || '')
                    .replace(/<[^>]*>/g, '')
                    .trim();
                const hasPoll =
                    input.poll &&
                    input.poll.question.trim() &&
                    input.poll.options.length > 0;

                if (
                    !textOnlyContent &&
                    pendingAttachments.length === 0 &&
                    !hasPoll
                ) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message:
                            'Post must have text content, at least one image/video, or a poll.',
                    });
                }

                // Determine the post title
                const postTitle =
                    input.title?.trim() ||
                    (input.poll ? input.poll.question.trim() : 'Untitled Post');

                // Use a transaction to create post and link tags
                const result = await db.transaction(async (tx) => {
                    // Determine the orgId for the post
                    // For super admins posting in communities, use the community's orgId
                    // For regular users, use their own orgId
                    let postOrgId = orgId;
                    if (isSuperAdmin && input.communityId) {
                        // For super admins, get the community's orgId
                        const community = await tx.query.communities.findFirst({
                            where: eq(communities.id, input.communityId),
                            columns: { orgId: true },
                        });
                        postOrgId = community?.orgId || orgId;
                    }

                    // Ensure we have a valid orgId
                    if (!postOrgId) {
                        throw new TRPCError({
                            code: 'BAD_REQUEST',
                            message:
                                'Unable to determine organization for post creation',
                        });
                    }

                    // Create the post
                    const [post] = await tx
                        .insert(posts)
                        .values({
                            title: postTitle,
                            content: input.content,
                            authorId: ctx.session?.user?.id ?? '',
                            orgId: postOrgId,
                            communityId: input.communityId || null,
                            visibility: input.communityId
                                ? 'community'
                                : 'public',
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        })
                        .returning();

                    // Link the post with tags if any are provided
                    if (input.tagIds && input.tagIds.length > 0) {
                        const postTagValues = input.tagIds.map((tagId) => ({
                            postId: post.id,
                            tagId: tagId,
                        }));

                        await tx.insert(postTags).values(postTagValues);
                    }

                    // Link any pending attachments to this new post
                    await tx
                        .update(attachments)
                        .set({ postId: post.id, updatedAt: new Date() })
                        .where(and(...baseAttachmentConds));

                    // Create poll if provided
                    let poll = null;
                    if (input.poll) {
                        const [createdPoll] = await tx
                            .insert(polls)
                            .values({
                                postId: post.id,
                                question: input.poll.question,
                                pollType: input.poll.pollType,
                                expiresAt: input.poll.expiresAt || null,
                                createdAt: new Date(),
                                updatedAt: new Date(),
                            })
                            .returning();

                        // Create poll options
                        const options = input.poll.options.map(
                            (text, index) => ({
                                pollId: createdPoll.id,
                                text,
                                orderIndex: index,
                                createdAt: new Date(),
                            }),
                        );

                        await tx.insert(pollOptions).values(options);
                        poll = createdPoll;
                    }

                    // Create Q&A configuration if provided
                    if (input.qa) {
                        const { qaQuestions } =
                            await import('@/server/db/schema');
                        await tx.insert(qaQuestions).values({
                            postId: post.id,
                            answersVisibleAt: input.qa.answersVisibleAt || null,
                            allowEditsUntil: input.qa.allowEditsUntil || null,
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        });
                    }

                    return { post, poll };
                });

                // Send notifications if post is in a community
                if (input.communityId) {
                    try {
                        // Get community and author details for notification
                        const [community, author] = await Promise.all([
                            db.query.communities.findFirst({
                                where: eq(communities.id, input.communityId),
                            }),
                            db.query.users.findFirst({
                                where: eq(
                                    users.id,
                                    ctx.session?.user?.id ?? '',
                                ),
                            }),
                        ]);

                        if (community && author) {
                            // Send push notifications
                            await sendCommunityPostNotification(
                                input.communityId,
                                postTitle,
                                author.name || 'Unknown User',
                                community.name,
                                result.post.id,
                                ctx.session?.user?.id ?? '', // Pass authorId to exclude post creator
                            );

                            // Save notifications to database for all eligible users
                            await saveCommunityPostNotifications(
                                postTitle,
                                author.name || 'Unknown User',
                                community.name,
                                result.post.id,
                                input.communityId,
                                ctx.session?.user?.id ?? '', // Pass authorId to exclude post creator
                            );
                        }
                    } catch (notificationError) {
                        // Log error but don't fail the post creation
                        console.error(
                            'Error sending notifications:',
                            notificationError,
                        );
                    }
                }

                return result.post;
            } catch (error) {
                console.error('Error creating post:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to create post',
                });
            }
        }),

    // Edit a post
    editPost: authProcedure
        .input(
            z
                .object({
                    postId: z.number(),
                    title: z.string().min(1).max(200).optional(),
                    content: z.string().min(1),
                    tagIds: z.array(z.number()).optional(),
                    poll: z
                        .object({
                            question: z.string().min(1).max(500),
                            pollType: z.enum(['single', 'multiple']),
                            // For edit, allow granular updates: options can be strings or { id?, text }
                            options: z
                                .array(
                                    z.union([
                                        z.string().min(1).max(200),
                                        z.object({
                                            id: z.number().optional(),
                                            text: z.string().min(1).max(200),
                                        }),
                                    ]),
                                )
                                .min(2)
                                .max(10),
                            expiresAt: z.date().optional(),
                        })
                        .optional(),
                })
                .refine((data) => data.title || data.poll, {
                    message: 'Either title or poll must be provided',
                }),
        )
        .mutation(async ({ input, ctx }) => {
            try {
                // Find the post with community information
                const post = await db.query.posts.findFirst({
                    where: eq(posts.id, input.postId),
                    with: {
                        community: true,
                    },
                });

                if (!post) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Post not found',
                    });
                }

                // Check permissions using ServerPermissions
                const permission = await ServerPermissions.fromUserId(
                    ctx.session.user.id,
                );

                // Check if user can edit this post
                let canEdit = false;

                // Check if user is the post author
                if (post.authorId === ctx.session.user.id) {
                    canEdit = true;
                } else if (post.communityId) {
                    // Check community permissions
                    canEdit = await permission.checkCommunityPermission(
                        post.communityId.toString(),
                        PERMISSIONS.EDIT_POST,
                    );
                } else {
                    // Check org permissions for org-wide posts
                    canEdit = permission.checkOrgPermission(
                        PERMISSIONS.EDIT_POST,
                    );
                }

                if (!canEdit) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message: 'You do not have permission to edit this post',
                    });
                }

                // Determine the post title
                const postTitle =
                    input.title?.trim() ||
                    (input.poll ? input.poll.question.trim() : 'Untitled Post');

                // Update post content/title
                const [updatedPost] = await db
                    .update(posts)
                    .set({
                        title: postTitle,
                        content: input.content,
                        updatedAt: new Date(),
                    })
                    .where(eq(posts.id, input.postId))
                    .returning();

                // Handle poll update if provided
                if (input.poll) {
                    // Check if poll already exists
                    const existingPoll = await db.query.polls.findFirst({
                        where: eq(polls.postId, input.postId),
                    });

                    if (existingPoll) {
                        // Update existing poll
                        await db
                            .update(polls)
                            .set({
                                question: input.poll.question.trim(),
                                pollType: input.poll.pollType,
                                expiresAt: input.poll.expiresAt || null,
                                updatedAt: new Date(),
                            })
                            .where(eq(polls.id, existingPoll.id));

                        // Normalize options: allow both strings and { id?, text }
                        const normalizedOptions = input.poll.options.map(
                            (opt) =>
                                typeof opt === 'string'
                                    ? {
                                          id: undefined as number | undefined,
                                          text: opt,
                                      }
                                    : { id: opt.id, text: opt.text },
                        );

                        // Fetch existing options
                        const existingOptions =
                            await db.query.pollOptions.findMany({
                                where: eq(pollOptions.pollId, existingPoll.id),
                            });
                        const existingById = new Map(
                            existingOptions.map((o) => [o.id, o]),
                        );

                        // Determine sets
                        const incomingWithIds = normalizedOptions
                            .map((o, index) => ({ ...o, orderIndex: index }))
                            .filter((o) => !!o.id) as Array<{
                            id: number;
                            text: string;
                            orderIndex: number;
                        }>;
                        const incomingIds = new Set(
                            incomingWithIds.map((o) => o.id),
                        );

                        const toUpdate = incomingWithIds.filter((o) =>
                            existingById.has(o.id),
                        );
                        const toInsert = normalizedOptions
                            .map((o, index) => ({ ...o, orderIndex: index }))
                            .filter((o) => !o.id);
                        const toDeleteIds = existingOptions
                            .filter((o) => !incomingIds.has(o.id))
                            .map((o) => o.id);

                        // Prevent deleting options that already have votes
                        if (toDeleteIds.length > 0) {
                            const voted = await db.query.pollVotes.findMany({
                                where: inArray(
                                    pollVotes.pollOptionId,
                                    toDeleteIds,
                                ),
                                columns: { id: true },
                            });
                            if (voted.length > 0) {
                                throw new TRPCError({
                                    code: 'BAD_REQUEST',
                                    message:
                                        'Cannot remove poll options that already have votes. Consider closing the poll or creating a new one.',
                                });
                            }
                        }

                        // Apply updates
                        for (const u of toUpdate) {
                            await db
                                .update(pollOptions)
                                .set({
                                    text: u.text.trim(),
                                    orderIndex: u.orderIndex,
                                })
                                .where(eq(pollOptions.id, u.id));
                        }

                        // Apply inserts
                        if (toInsert.length > 0) {
                            await db.insert(pollOptions).values(
                                toInsert.map((o) => ({
                                    pollId: existingPoll.id,
                                    text: o.text.trim(),
                                    orderIndex: o.orderIndex,
                                    createdAt: new Date(),
                                })),
                            );
                        }

                        // Apply deletes (safe - no votes)
                        if (toDeleteIds.length > 0) {
                            await db
                                .delete(pollOptions)
                                .where(inArray(pollOptions.id, toDeleteIds));
                        }
                    } else {
                        // Create new poll
                        const [newPoll] = await db
                            .insert(polls)
                            .values({
                                postId: input.postId,
                                question: input.poll.question.trim(),
                                pollType: input.poll.pollType,
                                expiresAt: input.poll.expiresAt || null,
                                isClosed: false,
                                createdAt: new Date(),
                                updatedAt: new Date(),
                            })
                            .returning();

                        // Insert poll options (normalize string | { id?, text })
                        const pollOptionValues = input.poll.options.map(
                            (opt, index) => {
                                const text =
                                    typeof opt === 'string' ? opt : opt.text;
                                return {
                                    pollId: newPoll.id,
                                    text: text.trim(),
                                    orderIndex: index,
                                    createdAt: new Date(),
                                };
                            },
                        );
                        await db.insert(pollOptions).values(pollOptionValues);
                    }
                }

                // Update tags if provided
                if (input.tagIds) {
                    // Remove existing tags
                    await db
                        .delete(postTags)
                        .where(eq(postTags.postId, input.postId));
                    // Add new tags
                    if (input.tagIds.length > 0) {
                        const postTagValues = input.tagIds.map((tagId) => ({
                            postId: input.postId,
                            tagId,
                        }));
                        await db.insert(postTags).values(postTagValues);
                    }
                }

                return updatedPost;
            } catch (error) {
                if (error instanceof TRPCError) {
                    throw error;
                }
                console.error('Error editing post:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to edit post',
                });
            }
        }),

    // Soft delete a post
    deletePost: authProcedure
        .input(
            z.object({
                postId: z.number(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            try {
                // Find the post with community information
                const postToDelete = await db.query.posts.findFirst({
                    where: eq(posts.id, input.postId),
                    with: {
                        community: true,
                    },
                });

                if (!postToDelete) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Post not found',
                    });
                }

                // Check permissions using ServerPermissions
                const permission = await ServerPermissions.fromUserId(
                    ctx.session.user.id,
                );

                // Check if user can delete this post
                let canDelete = false;

                // Check if user is the post author
                if (postToDelete.authorId === ctx.session.user.id) {
                    canDelete = true;
                } else if (postToDelete.communityId) {
                    // Check community permissions
                    canDelete = await permission.checkCommunityPermission(
                        postToDelete.communityId.toString(),
                        PERMISSIONS.DELETE_POST,
                    );
                } else {
                    // Check org permissions for org-wide posts
                    canDelete = permission.checkOrgPermission(
                        PERMISSIONS.DELETE_POST,
                    );
                }

                if (!canDelete) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message:
                            'You do not have permission to delete this post',
                    });
                }

                const [updatedPost] = await db
                    .update(posts)
                    .set({
                        isDeleted: true,
                        updatedAt: new Date(),
                    })
                    .where(eq(posts.id, input.postId))
                    .returning();

                return updatedPost;
            } catch (error) {
                if (error instanceof TRPCError) {
                    throw error;
                }
                console.error('Error deleting post:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to delete post',
                });
            }
        }),
};
