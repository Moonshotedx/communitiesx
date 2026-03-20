import { z } from 'zod';
import { authProcedure, publicProcedure } from '../trpc';
import { db } from '@/server/db';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { reactions, posts } from '@/server/db/schema';

export const reactionProcedures = {
    // Like a post
    likePost: authProcedure
        .input(z.object({ postId: z.number() }))
        .mutation(async ({ input, ctx }) => {
            try {
                const userId = ctx.session.user.id;
                const { postId } = input;

                // Check if post exists and is not deleted
                const post = await db.query.posts.findFirst({
                    where: and(
                        eq(posts.id, postId),
                        eq(posts.isDeleted, false),
                    ),
                });

                if (!post) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Post not found',
                    });
                }

                // Use transaction to prevent race conditions
                const result = await db.transaction(async (tx) => {
                    // Check if user already liked this post
                    const existingReaction = await tx.query.reactions.findFirst(
                        {
                            where: and(
                                eq(reactions.postId, postId),
                                eq(reactions.userId, userId),
                                eq(reactions.type, 'like'),
                            ),
                        },
                    );

                    if (existingReaction) {
                        throw new TRPCError({
                            code: 'BAD_REQUEST',
                            message: 'You have already liked this post',
                        });
                    }

                    // Add the like
                    await tx.insert(reactions).values({
                        postId,
                        userId,
                        type: 'like',
                    });

                    // Get updated like count
                    const likeCount = await tx
                        .select({ count: count() })
                        .from(reactions)
                        .where(
                            and(
                                eq(reactions.postId, postId),
                                eq(reactions.type, 'like'),
                            ),
                        );

                    return {
                        success: true,
                        likeCount: likeCount[0]?.count || 0,
                    } as const;
                });

                return result;
            } catch (error) {
                console.error('Error liking post:', error);
                if (error instanceof TRPCError) {
                    throw error;
                }
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to like post',
                });
            }
        }),

    // Unlike a post
    unlikePost: authProcedure
        .input(z.object({ postId: z.number() }))
        .mutation(async ({ input, ctx }) => {
            try {
                const userId = ctx.session.user.id;
                const { postId } = input;

                // Use transaction to prevent race conditions
                const result = await db.transaction(async (tx) => {
                    // Check if user has liked this post
                    const existingReaction = await tx.query.reactions.findFirst(
                        {
                            where: and(
                                eq(reactions.postId, postId),
                                eq(reactions.userId, userId),
                                eq(reactions.type, 'like'),
                            ),
                        },
                    );

                    if (!existingReaction) {
                        throw new TRPCError({
                            code: 'BAD_REQUEST',
                            message: 'You have not liked this post',
                        });
                    }

                    // Remove the like
                    await tx
                        .delete(reactions)
                        .where(
                            and(
                                eq(reactions.postId, postId),
                                eq(reactions.userId, userId),
                                eq(reactions.type, 'like'),
                            ),
                        );

                    // Get updated like count
                    const likeCount = await tx
                        .select({ count: count() })
                        .from(reactions)
                        .where(
                            and(
                                eq(reactions.postId, postId),
                                eq(reactions.type, 'like'),
                            ),
                        );

                    return {
                        success: true,
                        likeCount: likeCount[0]?.count || 0,
                    } as const;
                });

                return result;
            } catch (error) {
                console.error('Error unliking post:', error);
                if (error instanceof TRPCError) {
                    throw error;
                }
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to unlike post',
                });
            }
        }),

    // Get user's reaction status for posts
    getUserReactions: authProcedure
        .input(z.object({ postIds: z.array(z.number()).max(100) }))
        .query(async ({ input, ctx }) => {
            try {
                const userId = ctx.session.user.id;
                const { postIds } = input;

                if (postIds.length === 0) {
                    return {} as Record<number, boolean>;
                }

                const userReactions = await db.query.reactions.findMany({
                    where: and(
                        inArray(reactions.postId, postIds),
                        eq(reactions.userId, userId),
                        eq(reactions.type, 'like'),
                    ),
                    columns: { postId: true },
                });

                const reactionMap: Record<number, boolean> = {};
                userReactions.forEach((reaction) => {
                    reactionMap[reaction.postId] = true;
                });
                return reactionMap;
            } catch (error) {
                console.error('Error getting user reactions:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to get user reactions',
                });
            }
        }),

    // Get like counts for posts
    getPostLikeCounts: publicProcedure
        .input(z.object({ postIds: z.array(z.number()).max(100) }))
        .query(async ({ input }) => {
            try {
                const { postIds } = input;
                if (postIds.length === 0) {
                    return {} as Record<number, number>;
                }

                const likeCounts = await db
                    .select({ postId: reactions.postId, count: count() })
                    .from(reactions)
                    .where(
                        and(
                            inArray(reactions.postId, postIds),
                            eq(reactions.type, 'like'),
                        ),
                    )
                    .groupBy(reactions.postId);

                const countMap: Record<number, number> = {};
                likeCounts.forEach(({ postId, count }) => {
                    countMap[postId] = count;
                });
                return countMap;
            } catch (error) {
                console.error('Error getting post like counts:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to get post like counts',
                });
            }
        }),
};
