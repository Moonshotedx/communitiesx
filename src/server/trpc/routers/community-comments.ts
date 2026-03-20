import { z } from 'zod';
import { authProcedure, publicProcedure } from '../trpc';
import { db } from '@/server/db';
import { TRPCError } from '@trpc/server';
import { comments, commentHelpfulVotes, posts } from '@/server/db/schema';
import { and, count, desc, eq, inArray } from 'drizzle-orm';

export const commentProcedures = {
    // Create a comment
    createComment: authProcedure
        .input(
            z.object({
                postId: z.number(),
                content: z.string().min(1).max(10000),
                parentId: z.number().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            // Validate post exists
            const post = await db.query.posts.findFirst({
                where: eq(posts.id, input.postId),
            });
            if (!post) {
                throw new TRPCError({
                    code: 'NOT_FOUND',
                    message: 'Post not found',
                });
            }

            const [comment] = await db
                .insert(comments)
                .values({
                    content: input.content,
                    postId: input.postId,
                    authorId: ctx.session.user.id,
                    parentId: input.parentId,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                })
                .returning({
                    id: comments.id,
                    content: comments.content,
                    postId: comments.postId,
                    authorId: comments.authorId,
                    createdAt: comments.createdAt,
                    updatedAt: comments.updatedAt,
                });

            return comment;
        }),

    // Update a comment
    updateComment: authProcedure
        .input(
            z.object({
                commentId: z.number(),
                content: z.string().min(1).max(10000),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const commentToUpdate = await db.query.comments.findFirst({
                where: eq(comments.id, input.commentId),
            });
            if (!commentToUpdate) {
                throw new TRPCError({
                    code: 'NOT_FOUND',
                    message: 'Comment not found',
                });
            }
            if (commentToUpdate.authorId !== ctx.session.user.id) {
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: 'You are not authorized to edit this comment',
                });
            }

            const [updatedComment] = await db
                .update(comments)
                .set({ content: input.content, updatedAt: new Date() })
                .where(eq(comments.id, input.commentId))
                .returning();

            if (!updatedComment) {
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to update comment after verification',
                });
            }
            return updatedComment;
        }),

    // Soft delete a comment
    deleteComment: authProcedure
        .input(z.object({ commentId: z.number() }))
        .mutation(async ({ input, ctx }) => {
            const commentToDelete = await db.query.comments.findFirst({
                where: eq(comments.id, input.commentId),
                with: { post: { with: { community: true } } },
            });
            if (!commentToDelete) {
                throw new TRPCError({
                    code: 'NOT_FOUND',
                    message: 'Comment not found',
                });
            }

            // Author can always delete their own comments
            if (commentToDelete.authorId !== ctx.session.user.id) {
                // Check if user is a community moderator/admin
                const communityId = commentToDelete.post?.communityId;
                if (communityId) {
                    const { ServerPermissions } =
                        await import('@/server/utils/permission');
                    const permission = await ServerPermissions.fromUserId(
                        ctx.session.user.id,
                    );
                    const canManage = await permission.checkCommunityPermission(
                        communityId.toString(),
                        'delete_post',
                    );
                    if (!canManage) {
                        throw new TRPCError({
                            code: 'FORBIDDEN',
                            message:
                                'You do not have permission to delete this comment',
                        });
                    }
                } else {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message: 'You can only delete your own comments',
                    });
                }
            }

            const [updatedComment] = await db
                .update(comments)
                .set({ isDeleted: true, updatedAt: new Date() })
                .where(eq(comments.id, input.commentId))
                .returning();

            return updatedComment;
        }),

    // Get helpful vote counts for comments
    getCommentHelpfulCounts: publicProcedure
        .input(z.object({ commentIds: z.array(z.number()).max(100) }))
        .query(async ({ input }) => {
            if (input.commentIds.length === 0)
                return {} as Record<number, number>;
            const helpfulCounts = await db
                .select({
                    commentId: commentHelpfulVotes.commentId,
                    count: count(),
                })
                .from(commentHelpfulVotes)
                .where(inArray(commentHelpfulVotes.commentId, input.commentIds))
                .groupBy(commentHelpfulVotes.commentId);

            const countMap: Record<number, number> = {};
            helpfulCounts.forEach(({ commentId, count }) => {
                countMap[commentId] = count;
            });
            return countMap;
        }),

    // Get user's helpful votes for comments
    getUserHelpfulVotes: publicProcedure
        .input(z.object({ commentIds: z.array(z.number()).max(100) }))
        .query(async ({ input, ctx }) => {
            if (input.commentIds.length === 0 || !ctx.session?.user?.id) {
                return {} as Record<number, boolean>;
            }
            const userVotes = await db
                .select({ commentId: commentHelpfulVotes.commentId })
                .from(commentHelpfulVotes)
                .where(
                    and(
                        eq(commentHelpfulVotes.userId, ctx.session.user.id),
                        inArray(
                            commentHelpfulVotes.commentId,
                            input.commentIds,
                        ),
                    ),
                );

            const voteMap: Record<number, boolean> = {};
            userVotes.forEach(({ commentId }) => {
                voteMap[commentId] = true;
            });
            return voteMap;
        }),

    // Toggle helpful vote for a comment
    toggleCommentHelpful: authProcedure
        .input(z.object({ commentId: z.number() }))
        .mutation(async ({ input, ctx }) => {
            const comment = await db.query.comments.findFirst({
                where: eq(comments.id, input.commentId),
            });
            if (!comment) {
                throw new TRPCError({
                    code: 'NOT_FOUND',
                    message: 'Comment not found',
                });
            }

            const result = await db.transaction(async (tx) => {
                const existingVote =
                    await tx.query.commentHelpfulVotes.findFirst({
                        where: and(
                            eq(commentHelpfulVotes.commentId, input.commentId),
                            eq(commentHelpfulVotes.userId, ctx.session.user.id),
                        ),
                    });

                if (existingVote) {
                    await tx
                        .delete(commentHelpfulVotes)
                        .where(
                            and(
                                eq(
                                    commentHelpfulVotes.commentId,
                                    input.commentId,
                                ),
                                eq(
                                    commentHelpfulVotes.userId,
                                    ctx.session.user.id,
                                ),
                            ),
                        );
                } else {
                    await tx.insert(commentHelpfulVotes).values({
                        commentId: input.commentId,
                        userId: ctx.session.user.id,
                    });
                }

                const newCount = await tx
                    .select({ count: count() })
                    .from(commentHelpfulVotes)
                    .where(eq(commentHelpfulVotes.commentId, input.commentId));

                return {
                    helpfulCount: newCount[0]?.count ?? 0,
                    isHelpful: !existingVote,
                } as const;
            });

            return result;
        }),
};
