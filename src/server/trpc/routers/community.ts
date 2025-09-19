import { z } from 'zod';
import { router, publicProcedure, authProcedure } from '../trpc';
import {
    posts,
    comments,
    users,
    orgs,
    communities,
    communityMembers,
    communityInvites,
    communityMemberRequests,
    communityAllowedOrgs,
    tags,
    postTags,
    reactions,
} from '@/server/db/schema';
import { TRPCError } from '@trpc/server';
import {
    eq,
    desc,
    count,
    and,
    isNull,
    or,
    inArray,
    lt,
    ilike,
    sql,
    asc,
    gte,
    lte,
} from 'drizzle-orm';
import { db } from '@/server/db';
import type { Context } from '@/server/trpc/context';
import crypto from 'crypto';
import { sendEmail } from '@/lib/email';
import _ from 'lodash';
import { ServerPermissions } from '@/server/utils/permission';
import { PERMISSIONS } from '@/lib/permissions/permission-const';
import type { Community, CommunityAllowedOrg } from '@/types/models';
import { isOrgAdminForCommunity } from '@/lib/utils';
import { createCommunityInvitationEmail } from '@/lib/email-templates';

// Helper function to check if user is SuperAdmin
function isSuperAdmin(session: any): boolean {
    return session?.user?.appRole === 'admin';
}
import {
    sendCommunityPostNotification,
    saveCommunityPostNotifications,
} from '@/lib/community-notifications';

// Reusable helper to fetch community IDs for an organization
async function getCommunityIdsForOrg(orgId: string): Promise<number[]> {
    const orgCommunities = await db.query.communities.findMany({
        where: eq(communities.orgId, orgId),
        columns: { id: true },
    });
    return orgCommunities.map((community) => community.id);
}

// Define types for the responses based on schema
type UserType = typeof users.$inferSelect;
type PostType = typeof posts.$inferSelect;
type CommentType = typeof comments.$inferSelect;

type UserWithOrg = UserType & {
    organization?: {
        id: string;
        name: string;
    };
};

type PostWithAuthor = PostType & {
    author: UserWithOrg | null;
};

type CommentWithAuthor = CommentType & {
    author: UserType | null;
    replies?: CommentWithAuthor[]; // Add replies array for nesting
};

type PostWithAuthorAndComments = PostType & {
    author: UserType | null;
    comments: CommentWithAuthor[];
    community?: typeof communities.$inferSelect | null;
    tags: (typeof tags.$inferSelect)[];
};

type PostWithSource = PostWithAuthor & {
    source: {
        type: string;
        orgId?: string;
        communityId?: number;
        reason: string;
    };
    community?: typeof communities.$inferSelect | null;
    comments?: CommentType[];
};

export const communityRouter = router({
    // Create a new post
    createPost: authProcedure
        .input(
            z.object({
                title: z.string().min(1).max(200),
                content: z.string().min(1),
                communityId: z.number().nullable().optional(),
                orgId: z.string().optional().nullable(), // Add orgId as optional/nullable
                tagIds: z.array(z.number()).optional(),
            }),
        )
        .mutation(
            async ({
                input,
                ctx,
            }: {
                input: {
                    title: string;
                    content: string;
                    communityId?: number | null;
                    orgId?: string | null; // Add orgId as optional/nullable
                    tagIds?: number[]; // Add this line
                };
                ctx: Context;
            }) => {
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
                        const isOrgAdminForCommunityCheck =
                            isOrgAdminForCommunity(
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

                    // Use a transaction to create post and link tags
                    const result = await db.transaction(async (tx) => {
                        // Determine the orgId for the post
                        // For super admins posting in communities, use the community's orgId
                        // For regular users, use their own orgId
                        let postOrgId = orgId;
                        if (isSuperAdmin && input.communityId) {
                            // For super admins, get the community's orgId
                            const community =
                                await tx.query.communities.findFirst({
                                    where: eq(
                                        communities.id,
                                        input.communityId,
                                    ),
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
                                title: input.title.trim(),
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

                        return post;
                    });

                    // Send notifications if post is in a community
                    if (input.communityId) {
                        try {
                            // Get community and author details for notification
                            const [community, author] = await Promise.all([
                                db.query.communities.findFirst({
                                    where: eq(
                                        communities.id,
                                        input.communityId,
                                    ),
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
                                    input.title.trim(),
                                    author.name || 'Unknown User',
                                    community.name,
                                    result.id,
                                    ctx.session?.user?.id ?? '', // Pass authorId to exclude post creator
                                );

                                // Save notifications to database for all eligible users
                                await saveCommunityPostNotifications(
                                    input.title.trim(),
                                    author.name || 'Unknown User',
                                    community.name,
                                    result.id,
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

                    return result;
                } catch (error) {
                    console.error('Error creating post:', error);
                    throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: 'Failed to create post',
                    });
                }
            },
        ),

    // Get all posts (org-specific) that don't belong to any community
    getPosts: authProcedure.query(
        async ({ ctx }): Promise<PostWithAuthor[]> => {
            try {
                // Always fetch orgId from DB
                const user = await db.query.users.findFirst({
                    where: eq(users.id, ctx.session.user.id),
                });
                const orgId = user?.orgId;
                if (!orgId) {
                    throw new TRPCError({
                        code: 'UNAUTHORIZED',
                        message: 'User does not have an organization.',
                    });
                }
                const allPostsFromDb = await db.query.posts.findMany({
                    where: and(
                        eq(posts.orgId, orgId),
                        isNull(posts.communityId), // Only include posts that don't belong to a community
                    ),
                    orderBy: desc(posts.createdAt),
                    with: {
                        author: true,
                    },
                });
                return allPostsFromDb as PostWithAuthor[];
            } catch (error) {
                console.error('Error fetching posts:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to fetch posts',
                });
            }
        },
    ),

    // Get posts from communities the user is a member of or following
    // NOTE: This procedure now returns paginated results. Consider using getAllRelevantPosts
    // for more comprehensive post fetching with better pagination support.
    getRelevantPosts: authProcedure
        .input(
            z.object({
                limit: z.number().min(1).max(100).default(20),
                offset: z.number().default(0),
            }),
        )
        .query(
            async ({
                ctx,
                input,
            }): Promise<{
                posts: PostWithAuthor[];
                nextOffset: number | null;
                hasNextPage: boolean;
                totalCount: number;
            }> => {
                try {
                    const { limit, offset } = input;
                    const userId = ctx.session.user.id;

                    // Check if user is SuperAdmin
                    const user = await db.query.users.findFirst({
                        where: eq(users.id, userId),
                        columns: {
                            role: true,
                            orgId: true,
                        },
                    });

                    // If SuperAdmin, get posts from ALL communities with pagination
                    if (isSuperAdmin(ctx.session)) {
                        const whereClause = eq(posts.isDeleted, false);

                        // Fetch total count and paginated posts in parallel for efficiency
                        const [totalCountResult, paginatedDbPosts] =
                            await Promise.all([
                                db
                                    .select({ count: sql<number>`count(*)` })
                                    .from(posts)
                                    .where(whereClause),
                                db.query.posts.findMany({
                                    where: whereClause,
                                    orderBy: [desc(posts.createdAt)],
                                    limit,
                                    offset,
                                    with: {
                                        author: true,
                                        community: true,
                                    },
                                }),
                            ]);

                        const totalCount = totalCountResult[0]?.count || 0;

                        const hasNextPage = offset + limit < totalCount;
                        const nextOffset = hasNextPage ? offset + limit : null;

                        return {
                            posts: paginatedDbPosts as PostWithAuthor[],
                            nextOffset,
                            hasNextPage,
                            totalCount,
                        };
                    }

                    // Get all communities where the user is a member or follower
                    const userCommunities =
                        await db.query.communityMembers.findMany({
                            where: and(
                                eq(communityMembers.userId, userId),
                                eq(communityMembers.status, 'active'),
                            ),
                            with: {
                                community: true,
                            },
                        });

                    // --- ORG ADMIN OVERRIDE ---
                    // If user is org admin, also get communities from their org
                    let additionalCommunityIds: number[] = [];
                    if (user?.orgId) {
                        if (user.role === 'admin') {
                            additionalCommunityIds =
                                await getCommunityIdsForOrg(user.orgId);
                        }
                    }

                    // Extract community IDs from memberships
                    const membershipCommunityIds = userCommunities.map(
                        (membership) => membership.communityId,
                    );

                    // Combine membership communities with org admin communities
                    const allCommunityIds = [
                        ...new Set([
                            ...membershipCommunityIds,
                            ...additionalCommunityIds,
                        ]),
                    ];

                    // If user isn't part of any communities and isn't org admin, return empty result
                    if (allCommunityIds.length === 0) {
                        return {
                            posts: [],
                            nextOffset: null,
                            hasNextPage: false,
                            totalCount: 0,
                        };
                    }

                    // Get total count for pagination
                    const totalCountResult = await db
                        .select({ count: count() })
                        .from(posts)
                        .where(
                            and(
                                inArray(posts.communityId, allCommunityIds),
                                eq(posts.isDeleted, false),
                            ),
                        );

                    const totalCount = totalCountResult[0]?.count || 0;

                    // Get posts from these communities with pagination
                    const relevantPosts = await db.query.posts.findMany({
                        where: and(
                            inArray(posts.communityId, allCommunityIds),
                            eq(posts.isDeleted, false),
                        ),
                        orderBy: desc(posts.createdAt),
                        limit: limit,
                        offset: offset,
                        with: {
                            author: true,
                            community: true,
                        },
                    });

                    const hasNextPage = offset + limit < totalCount;
                    const nextOffset = hasNextPage ? offset + limit : null;

                    return {
                        posts: relevantPosts as PostWithAuthor[],
                        nextOffset,
                        hasNextPage,
                        totalCount,
                    };
                } catch (error) {
                    console.error('Error fetching relevant posts:', error);
                    throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: 'Failed to fetch relevant posts',
                    });
                }
            },
        ),

    // Get all posts relevant to user (org-wide + community posts)
    getAllRelevantPosts: authProcedure
        .input(
            z.object({
                limit: z.number().min(1).max(100).default(10),
                offset: z.number().default(0),
                sort: z
                    .enum(['latest', 'oldest', 'most-commented'])
                    .default('latest'),
                dateFilter: z
                    .object({
                        type: z
                            .enum(['all', 'today', 'week', 'month', 'custom'])
                            .default('all'),
                        startDate: z.date().optional(),
                        endDate: z.date().optional(),
                    })
                    .optional()
                    .default({ type: 'all' }),
            }),
        )
        .query(async ({ ctx, input }) => {
            try {
                const { limit, offset, sort, dateFilter } = input;
                const userId = ctx.session.user.id;

                // Helper function to create date filter conditions
                const createDateFilter = () => {
                    if (dateFilter.type === 'all') {
                        return undefined;
                    }

                    const now = new Date();
                    let startDate: Date;
                    let endDate: Date = now;

                    switch (dateFilter.type) {
                        case 'today':
                            startDate = new Date(
                                now.getFullYear(),
                                now.getMonth(),
                                now.getDate(),
                            );
                            endDate = new Date(
                                now.getFullYear(),
                                now.getMonth(),
                                now.getDate(),
                                23,
                                59,
                                59,
                                999,
                            );
                            break;
                        case 'week':
                            startDate = new Date(
                                now.getTime() - 7 * 24 * 60 * 60 * 1000,
                            );
                            break;
                        case 'month':
                            startDate = new Date(
                                now.getTime() - 30 * 24 * 60 * 60 * 1000,
                            );
                            break;
                        case 'custom':
                            if (dateFilter.startDate && dateFilter.endDate) {
                                startDate = dateFilter.startDate;
                                endDate = dateFilter.endDate;
                            } else {
                                return undefined;
                            }
                            break;
                        default:
                            return undefined;
                    }

                    return and(
                        gte(posts.createdAt, startDate),
                        lte(posts.createdAt, endDate),
                    );
                };

                const dateFilterCondition = createDateFilter();

                // Check if user is SuperAdmin
                const user = await db.query.users.findFirst({
                    where: eq(users.id, userId),
                    columns: {
                        role: true,
                        orgId: true,
                    },
                });

                // If SuperAdmin, get posts from ALL communities and organizations
                if (isSuperAdmin(ctx.session)) {
                    const whereClause = dateFilterCondition
                        ? and(eq(posts.isDeleted, false), dateFilterCondition)
                        : eq(posts.isDeleted, false);

                    // For comment count sorting, we need to fetch posts with comment counts
                    let orderByClause;
                    if (sort === 'most-commented') {
                        // Use a subquery to get comment counts and sort by them
                        orderByClause = sql`(
                            SELECT COUNT(*) FROM comments c 
                            WHERE c.post_id = posts.id AND c.is_deleted = false
                        ) DESC`;
                    } else {
                        orderByClause =
                            sort === 'latest'
                                ? desc(posts.createdAt)
                                : asc(posts.createdAt);
                    }

                    // Fetch total count and paginated posts in parallel for efficiency
                    const [totalCountResult, paginatedDbPosts] =
                        await Promise.all([
                            db
                                .select({ count: sql<number>`count(*)` })
                                .from(posts)
                                .where(whereClause),
                            db.query.posts.findMany({
                                where: whereClause,
                                orderBy: [orderByClause],
                                limit,
                                offset,
                                with: {
                                    author: {
                                        with: {
                                            organization: true,
                                        },
                                    },
                                    community: true,
                                    comments: true,
                                    postTags: {
                                        with: {
                                            tag: true,
                                        },
                                    },
                                },
                            }),
                        ]);

                    const totalCount = totalCountResult[0]?.count || 0;

                    // Add source information to the paginated posts
                    const postsWithSource = paginatedDbPosts.map((post) => ({
                        ...post,
                        tags: post.postTags.map((pt) => pt.tag),
                        source: {
                            type: post.communityId ? 'community' : 'org',
                            orgId: post.orgId,
                            communityId: post.communityId
                                ? post.communityId
                                : undefined,
                            reason: post.communityId
                                ? `SuperAdmin access to ${post.community?.name || 'community'}`
                                : `SuperAdmin access to organization`,
                        },
                    }));

                    const hasNextPage = offset + limit < totalCount;
                    const nextOffset = hasNextPage ? offset + limit : null;

                    return {
                        posts: postsWithSource,
                        nextOffset,
                        hasNextPage,
                        totalCount,
                    };
                }

                // Get user's org ID
                const orgId = user?.orgId;

                if (!orgId) {
                    throw new TRPCError({
                        code: 'UNAUTHORIZED',
                        message: 'User does not have an organization.',
                    });
                }

                // Get all communities where the user is a member or follower
                const userMemberships =
                    await db.query.communityMembers.findMany({
                        where: and(
                            eq(communityMembers.userId, userId),
                            eq(communityMembers.status, 'active'),
                        ),
                        with: {
                            community: true,
                        },
                    });

                // --- ORG ADMIN OVERRIDE ---
                // If user is org admin, also get communities from their org
                let additionalCommunityIds: number[] = [];
                if (user?.orgId) {
                    if (user.role === 'admin') {
                        additionalCommunityIds = await getCommunityIdsForOrg(
                            user.orgId,
                        );
                    }
                }

                // Create a map of community ID to membership type for quick lookup
                const communityMembershipMap = new Map();
                userMemberships.forEach((membership) => {
                    communityMembershipMap.set(
                        membership.communityId,
                        membership.membershipType,
                    );
                });

                // Extract community IDs from memberships
                const membershipCommunityIds = userMemberships.map(
                    (membership) => membership.communityId,
                );

                // Combine membership communities with org admin communities
                const allCommunityIds = [
                    ...new Set([
                        ...membershipCommunityIds,
                        ...additionalCommunityIds,
                    ]),
                ];

                // Build a single WHERE clause that covers both org posts and community posts
                const baseWhereConditions = [eq(posts.isDeleted, false)];

                if (dateFilterCondition) {
                    baseWhereConditions.push(dateFilterCondition);
                }

                // Create OR condition for org posts OR community posts
                const orgCondition = and(
                    eq(posts.orgId, orgId),
                    isNull(posts.communityId),
                );

                const communityCondition =
                    allCommunityIds.length > 0
                        ? inArray(posts.communityId, allCommunityIds)
                        : sql`false`; // If no communities, this condition will never match

                const combinedWhere = and(
                    ...baseWhereConditions,
                    or(orgCondition, communityCondition),
                );

                // Build ORDER BY clause
                let orderByClause;
                if (sort === 'most-commented') {
                    // Use a subquery to get comment counts and sort by them
                    orderByClause = sql`(
                        SELECT COUNT(*) FROM comments c 
                        WHERE c.post_id = posts.id AND c.is_deleted = false
                    ) DESC`;
                } else {
                    orderByClause =
                        sort === 'latest'
                            ? desc(posts.createdAt)
                            : asc(posts.createdAt);
                }

                // Get organization name for source information
                const organization = await db.query.orgs.findFirst({
                    where: eq(orgs.id, orgId),
                });
                const orgName = organization?.name || 'your organization';

                // Execute single query with proper pagination and sorting
                const [totalCountResult, paginatedDbPosts] = await Promise.all([
                    // Get total count
                    db
                        .select({ count: sql<number>`count(*)` })
                        .from(posts)
                        .where(combinedWhere),
                    // Get paginated posts with all relations
                    db.query.posts.findMany({
                        where: combinedWhere,
                        orderBy: [orderByClause],
                        limit,
                        offset,
                        with: {
                            author: {
                                with: {
                                    organization: true,
                                },
                            },
                            community: true,
                            comments: true,
                            postTags: {
                                with: {
                                    tag: true,
                                },
                            },
                        },
                    }),
                ]);

                const totalCount = totalCountResult[0]?.count || 0;

                // Add source information to posts
                const postsWithSource = paginatedDbPosts.map((post) => {
                    const isOrgPost = post.orgId === orgId && !post.communityId;
                    const membershipType = post.communityId
                        ? communityMembershipMap.get(post.communityId)
                        : null;

                    return {
                        ...post,
                        tags: post.postTags.map((pt) => pt.tag), // Transform postTags to tags
                        source: isOrgPost
                            ? {
                                  type: 'org' as const,
                                  orgId,
                                  reason: `Because you are part of ${orgName}`,
                              }
                            : {
                                  type: 'community' as const,
                                  communityId: post.communityId
                                      ? post.communityId
                                      : undefined,
                                  reason:
                                      membershipType === 'member'
                                          ? `Because you are a member of ${post.community?.name}`
                                          : `Because you are following ${post.community?.name}`,
                              },
                    } as PostWithSource;
                });

                // Check if there are more results
                const hasNextPage = offset + limit < totalCount;
                const nextOffset = hasNextPage ? offset + limit : null;

                return {
                    posts: postsWithSource,
                    nextOffset,
                    hasNextPage,
                    totalCount,
                };
            } catch (error) {
                console.error('Error fetching all relevant posts:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to fetch posts',
                });
            }
        }),

    // Get a single post with its comments
    getPost: authProcedure
        .input(
            z.object({
                postId: z.number(),
            }),
        )
        .query(async ({ input, ctx }): Promise<PostWithAuthorAndComments> => {
            try {
                const postFromDb = await db.query.posts.findFirst({
                    where: eq(posts.id, input.postId),
                    with: {
                        author: true,
                        community: true,
                    },
                });

                if (!postFromDb) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Post not found',
                    });
                }

                // Check if post is from a private community and if user has access
                if (
                    postFromDb.communityId &&
                    postFromDb.community?.type === 'private'
                ) {
                    // Check if user is a member or follower of the community
                    const membership =
                        await db.query.communityMembers.findFirst({
                            where: and(
                                eq(
                                    communityMembers.userId,
                                    ctx.session.user.id,
                                ),
                                eq(
                                    communityMembers.communityId,
                                    postFromDb.communityId,
                                ),
                                eq(communityMembers.status, 'active'),
                            ),
                        });

                    // --- ORG ADMIN OVERRIDE ---
                    // Check if user is org admin for this community
                    const isOrgAdminForCommunityCheck = isOrgAdminForCommunity(
                        ctx.session.user,
                        postFromDb.community?.orgId,
                    );

                    if (!membership && !isOrgAdminForCommunityCheck) {
                        throw new TRPCError({
                            code: 'FORBIDDEN',
                            message:
                                'You must be a member or follower of this community to view this post',
                        });
                    }
                }

                // Fetch all comments for the post separately
                const allCommentsForPost = await db.query.comments.findMany({
                    where: eq(comments.postId, input.postId),
                    with: {
                        author: true,
                    },
                    orderBy: desc(comments.createdAt), // Or asc(comments.createdAt) depending on desired order
                });

                // Structure comments into a tree
                const commentsById: { [key: number]: CommentWithAuthor } = {};
                allCommentsForPost.forEach((comment) => {
                    commentsById[comment.id] = {
                        ...(comment as CommentWithAuthor),
                        replies: [],
                    };
                });

                const nestedComments: CommentWithAuthor[] = [];
                allCommentsForPost.forEach((comment) => {
                    if (comment.parentId && commentsById[comment.parentId]) {
                        commentsById[comment.parentId].replies?.push(
                            commentsById[comment.id],
                        );
                    } else {
                        nestedComments.push(commentsById[comment.id]);
                    }
                });

                // The Drizzle 'with' for comments is removed, so we manually add the structured comments.
                const result: PostWithAuthorAndComments = {
                    ...(postFromDb as PostWithAuthorAndComments),
                    comments: nestedComments.sort(
                        (a, b) =>
                            new Date(b.createdAt).getTime() -
                            new Date(a.createdAt).getTime(),
                    ), // Ensure top-level comments are sorted as before
                };

                return result;
            } catch (error) {
                if (error instanceof TRPCError) {
                    throw error;
                }
                console.error('Error fetching post:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to fetch post',
                });
            }
        }),

    // Create a comment
    createComment: authProcedure
        .input(
            z.object({
                postId: z.number(),
                content: z.string().min(1),
                parentId: z.number().optional(),
            }),
        )
        .mutation(
            async ({
                input,
                ctx,
            }: {
                input: { postId: number; content: string; parentId?: number };
                ctx: Context;
            }) => {
                try {
                    // First check if the post exists
                    const orgId = (ctx.session?.user as any).orgId;
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
                            authorId: ctx.session?.user?.id ?? '',
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
                } catch (error) {
                    if (error instanceof TRPCError) {
                        throw error;
                    }
                    console.error('Error creating comment:', error);
                    throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: 'Failed to create comment',
                    });
                }
            },
        ),

    // Update a comment
    updateComment: authProcedure
        .input(
            z.object({
                commentId: z.number(),
                content: z.string().min(1),
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

            try {
                const [updatedComment] = await db
                    .update(comments)
                    .set({
                        content: input.content,
                        updatedAt: new Date(),
                    })
                    .where(eq(comments.id, input.commentId))
                    .returning();

                if (!updatedComment) {
                    // This case should ideally not happen if the findFirst above succeeded
                    // and no one deleted the comment in between.
                    throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: 'Failed to update comment after verification',
                    });
                }

                return updatedComment;
            } catch (error) {
                console.error('Error updating comment:', error);
                if (error instanceof TRPCError) throw error;
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to update comment',
                });
            }
        }),

    // Edit a post
    editPost: authProcedure
        .input(
            z.object({
                postId: z.number(),
                title: z.string().min(1).max(200),
                content: z.string().min(1),
                tagIds: z.array(z.number()).optional(),
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

                // Update post content/title
                const [updatedPost] = await db
                    .update(posts)
                    .set({
                        title: input.title,
                        content: input.content,
                        updatedAt: new Date(),
                    })
                    .where(eq(posts.id, input.postId))
                    .returning();

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

    // Soft delete a comment
    deleteComment: authProcedure
        .input(
            z.object({
                commentId: z.number(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            try {
                const commentToDelete = await db.query.comments.findFirst({
                    where: eq(comments.id, input.commentId),
                    with: {
                        post: {
                            with: {
                                community: true,
                            },
                        },
                    },
                });

                if (!commentToDelete) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Comment not found',
                    });
                }

                // Check permissions using ServerPermissions
                const permission = await ServerPermissions.fromUserId(
                    ctx.session.user.id,
                );

                // Check if user can delete this comment
                let canDelete = false;

                // Check if user is the comment author
                if (commentToDelete.authorId === ctx.session.user.id) {
                    canDelete = true;
                } else if (commentToDelete.post.communityId) {
                    // Check community permissions
                    canDelete = await permission.checkCommunityPermission(
                        commentToDelete.post.communityId.toString(),
                        PERMISSIONS.DELETE_POST, // Use DELETE_POST permission for comments too
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
                            'You are not authorized to delete this comment',
                    });
                }

                const [updatedComment] = await db
                    .update(comments)
                    .set({
                        isDeleted: true,
                        updatedAt: new Date(),
                    })
                    .where(eq(comments.id, input.commentId))
                    .returning();

                return updatedComment;
            } catch (error) {
                if (error instanceof TRPCError) {
                    throw error;
                }
                console.error('Error deleting comment:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to delete comment',
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

    // Get statistics for the community
    getStats: authProcedure.query(async ({ ctx }) => {
        try {
            // Get the user's organization
            const user = await db.query.users.findFirst({
                where: eq(users.id, ctx.session.user.id),
            });

            const orgId = user?.orgId;
            if (!orgId) {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'User does not have an organization.',
                });
            }

            // Count total users in the organization
            const usersResult = await db
                .select({ count: count() })
                .from(users)
                .where(eq(users.orgId, orgId));

            const totalUsers = usersResult[0]?.count || 0;

            // Count total posts in the organization
            const postsResult = await db
                .select({ count: count() })
                .from(posts)
                .where(eq(posts.orgId, orgId));

            const totalPosts = postsResult[0]?.count || 0;

            // Count total communities in the database (global)
            const communitiesResult = await db
                .select({ count: count() })
                .from(communities);

            const totalCommunities = communitiesResult[0]?.count || 0;

            // Count communities associated with the user's organization
            // 1. Communities where orgId matches
            const orgCreatedCommunitiesResult = await db
                .select({ id: communities.id })
                .from(communities)
                .where(eq(communities.orgId, orgId));
            const orgCreatedCommunityIds = orgCreatedCommunitiesResult.map(
                (c) => c.id,
            );

            // 2. Communities where org is in communityAllowedOrgs
            const allowedCommunitiesResult = await db
                .select({ communityId: communityAllowedOrgs.communityId })
                .from(communityAllowedOrgs)
                .where(eq(communityAllowedOrgs.orgId, orgId));
            const allowedCommunityIds = allowedCommunitiesResult.map(
                (c) => c.communityId,
            );

            // Combine and dedupe
            const orgCommunityIdSet = new Set([
                ...orgCreatedCommunityIds,
                ...allowedCommunityIds,
            ]);
            const orgCommunityCount = orgCommunityIdSet.size;

            return {
                totalUsers,
                totalPosts,
                totalCommunities: orgCommunityCount,
                // totalCommunities, // global
                orgCommunityCount, // org-specific
            };
        } catch (error) {
            console.error('Error fetching statistics:', error);
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to fetch statistics',
            });
        }
    }),

    // Get admin users for the community
    getAdmins: authProcedure.query(async ({ ctx }) => {
        try {
            // Get the user's organization
            const user = await db.query.users.findFirst({
                where: eq(users.id, ctx.session.user.id),
            });

            const orgId = user?.orgId;
            if (!orgId) {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'User does not have an organization.',
                });
            }

            // Find admin users in the organization
            const adminUsers = await db.query.users.findMany({
                where: and(eq(users.orgId, orgId), eq(users.role, 'admin')),
                orderBy: [users.name],
            });

            return adminUsers;
        } catch (error) {
            console.error('Error fetching admins:', error);
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to fetch admins',
            });
        }
    }),

    // Create a new community
    create: authProcedure
        .input(
            z.object({
                name: z.string().min(3).max(50),
                slug: z
                    .string()
                    .min(3)
                    .max(50)
                    .regex(/^[a-z0-9-]+$/),
                description: z.string().max(500).nullable(),
                type: z.enum(['public', 'private']),
                rules: z.string().max(2000).nullable(),
                avatar: z.string().nullable(),
                banner: z.string().nullable(),
                postCreationMinRole: z
                    .enum(['member', 'moderator', 'admin'])
                    .default('member'), // Minimum role required to create posts
                orgId: z.string().nullable().default(null), // Ensure orgId is string|null, never undefined
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (!ctx.session?.user?.id) {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'You must be logged in to create a community',
                });
            }
            const permission = await ServerPermissions.fromUserId(
                ctx.session.user.id,
            );

            // SuperAdmin can create communities anywhere, others need org permission
            let canCreateCommunity = false;
            if (permission.isAppAdmin()) {
                canCreateCommunity = true;
            } else {
                canCreateCommunity = permission.checkOrgPermission(
                    PERMISSIONS.CREATE_COMMUNITY,
                );
            }

            if (!canCreateCommunity) {
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: 'You do not have permission to create a community',
                });
            }

            try {
                const existingCommunity = await db.query.communities.findFirst({
                    where: eq(communities.slug, input.slug),
                });

                if (existingCommunity) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'Community URL is already taken',
                    });
                }

                // Create the community
                const [community] = await db
                    .insert(communities)
                    .values({
                        name: input.name,
                        slug: input.slug,
                        description: input.description,
                        type: input.type,
                        rules: input.rules,
                        avatar: input.avatar,
                        banner: input.banner,
                        postCreationMinRole: input.postCreationMinRole,
                        orgId: input.orgId,
                        createdBy: ctx.session.user.id,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .returning();

                // Add creator as an admin
                await db.insert(communityMembers).values({
                    userId: ctx.session.user.id,
                    communityId: community.id,
                    role: 'admin',
                    membershipType: 'member',
                    status: 'active',
                    joinedAt: new Date(),
                    updatedAt: new Date(),
                });

                // Only insert into communityAllowedOrgs if orgId is a non-empty string
                if (
                    input.orgId &&
                    typeof input.orgId === 'string' &&
                    input.orgId.trim() !== ''
                ) {
                    await db.insert(communityAllowedOrgs).values({
                        communityId: community.id,
                        orgId: input.orgId,
                        permissions: 'view',
                        addedBy: ctx.session.user.id,
                        addedAt: new Date(),
                    });
                }

                return community;
            } catch (error) {
                if (error instanceof TRPCError) {
                    throw error;
                }
                console.error('Error creating community:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to create community',
                });
            }
        }),

    // Update community details (admin only)
    updateCommunity: publicProcedure
        .input(
            z.object({
                communityId: z.number(),
                name: z.string().min(3).max(50).optional(),
                description: z.string().max(500).nullable().optional(),
                type: z.enum(['public', 'private']).optional(),
                rules: z.string().max(2000).nullable().optional(),
                banner: z.string().nullable().optional(),
                avatar: z.string().nullable().optional(),
                postCreationMinRole: z
                    .enum(['member', 'moderator', 'admin'])
                    .optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (!ctx.session?.user) {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'You must be logged in to update a community',
                });
            }

            const permission = await ServerPermissions.fromUserId(
                ctx.session.user.id,
            );
            const canUpdateCommunity =
                await permission.checkCommunityPermission(
                    input.communityId.toString(),
                    PERMISSIONS.EDIT_COMMUNITY,
                );

            if (!canUpdateCommunity) {
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message:
                        'You do not have permission to update this community',
                });
            }

            try {
                const updateData: any = {
                    updatedAt: new Date(),
                };

                if (input.name) updateData.name = input.name;
                if (input.description !== undefined)
                    updateData.description = input.description;
                if (input.type !== undefined) updateData.type = input.type;
                if (input.rules !== undefined) updateData.rules = input.rules;
                if (input.banner !== undefined)
                    updateData.banner = input.banner;
                if (input.avatar !== undefined)
                    updateData.avatar = input.avatar;
                if (input.postCreationMinRole !== undefined)
                    updateData.postCreationMinRole = input.postCreationMinRole;

                const [updatedCommunity] = await db
                    .update(communities)
                    .set(updateData)
                    .where(eq(communities.id, input.communityId))
                    .returning();

                return updatedCommunity;
            } catch (error) {
                console.error('Error updating community:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to update community',
                });
            }
        }),

    // Assign moderator role to a community member (admin only)
    assignModerator: authProcedure
        .input(
            z.object({
                communityId: z.number(),
                userId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const permission = await ServerPermissions.fromUserId(
                ctx.session.user.id,
            );
            const canAssignModerator =
                await permission.checkCommunityPermission(
                    input.communityId.toString(),
                    PERMISSIONS.MANAGE_COMMUNITY_MEMBERS,
                );

            if (!canAssignModerator) {
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: 'You do not have permission to assign moderator',
                });
            }
            // Check if the target user is a member of the community
            const targetMembership = await db.query.communityMembers.findFirst({
                where: and(
                    eq(communityMembers.userId, input.userId),
                    eq(communityMembers.communityId, input.communityId),
                    eq(communityMembers.membershipType, 'member'),
                ),
            });

            if (!targetMembership) {
                throw new TRPCError({
                    code: 'BAD_REQUEST',
                    message:
                        'The user must be a member of the community to be assigned as moderator',
                });
            }

            try {
                const [updatedMembership] = await db
                    .update(communityMembers)
                    .set({
                        role: 'moderator',
                        updatedAt: new Date(),
                    })
                    .where(
                        and(
                            eq(communityMembers.userId, input.userId),
                            eq(communityMembers.communityId, input.communityId),
                        ),
                    )
                    .returning();

                return updatedMembership;
            } catch (error) {
                console.error('Error assigning moderator:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to assign moderator role',
                });
            }
        }),

    // Remove moderator role from a community member (admin only)
    removeModerator: publicProcedure
        .input(
            z.object({
                communityId: z.number(),
                userId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (!ctx.session?.user) {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'You must be logged in to remove moderators',
                });
            }

            // Use permission system to check if user can manage community members
            const permission = await ServerPermissions.fromUserId(
                ctx.session.user.id,
            );
            const canRemoveModerator =
                await permission.checkCommunityPermission(
                    input.communityId.toString(),
                    PERMISSIONS.MANAGE_COMMUNITY_MEMBERS,
                );

            if (!canRemoveModerator) {
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: 'You do not have permission to remove moderators',
                });
            }

            // Check if the target user is a moderator of the community
            const targetMembership = await db.query.communityMembers.findFirst({
                where: and(
                    eq(communityMembers.userId, input.userId),
                    eq(communityMembers.communityId, input.communityId),
                    eq(communityMembers.role, 'moderator'),
                ),
            });

            if (!targetMembership) {
                throw new TRPCError({
                    code: 'BAD_REQUEST',
                    message: 'The user is not a moderator of this community',
                });
            }

            try {
                const [updatedMembership] = await db
                    .update(communityMembers)
                    .set({
                        role: 'member',
                        updatedAt: new Date(),
                    })
                    .where(
                        and(
                            eq(communityMembers.userId, input.userId),
                            eq(communityMembers.communityId, input.communityId),
                        ),
                    )
                    .returning();

                return updatedMembership;
            } catch (error) {
                console.error('Error removing moderator:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to remove moderator role',
                });
            }
        }),

    // Create invite link for a community (admin and moderator)
    createInviteLink: authProcedure
        .input(
            z.object({
                communityId: z.number(),
                role: z
                    .enum(['member', 'moderator', 'admin'])
                    .default('member'),
                expiresInDays: z.number().min(1).max(30).default(7),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const permission = await ServerPermissions.fromUserId(
                ctx.session.user.id,
            );

            // Check if user can create invite links
            const canCreateInvite = await permission.checkCommunityPermission(
                input.communityId.toString(),
                PERMISSIONS.MANAGE_COMMUNITY_MEMBERS,
            );

            if (!canCreateInvite) {
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message:
                        'You do not have permission to create invite links',
                });
            }

            // Check if user can assign admin role (if trying to create admin invite)
            if (input.role === 'admin') {
                const canAssignAdmin =
                    await permission.checkCommunityPermission(
                        input.communityId.toString(),
                        PERMISSIONS.ASSIGN_COMMUNITY_ADMIN,
                    );

                if (!canAssignAdmin) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message:
                            'You do not have permission to create admin invite links',
                    });
                }
            }

            try {
                // Generate a unique code
                const code = crypto.randomUUID();

                // Calculate expiration date
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + input.expiresInDays);

                const [invite] = await db
                    .insert(communityInvites)
                    .values({
                        communityId: input.communityId,
                        code,
                        role: input.role,
                        createdBy: ctx.session.user.id,
                        createdAt: new Date(),
                        expiresAt,
                    })
                    .returning();

                return {
                    ...invite,
                    inviteLink: `/communities/join/${code}`,
                };
            } catch (error) {
                console.error('Error creating invite link:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to create invite link',
                });
            }
        }),

    // Get information about an invitation
    getInviteInfo: publicProcedure
        .input(
            z.object({
                inviteCode: z.string(),
            }),
        )
        .query(async ({ input }) => {
            try {
                // Find the invite with community information
                const invite = await db.query.communityInvites.findFirst({
                    where: eq(communityInvites.code, input.inviteCode),
                    with: {
                        community: true,
                        organization: true,
                    },
                });

                if (!invite) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Invalid invite code',
                    });
                }

                // Check if the invite has expired
                if (invite.expiresAt < new Date()) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'This invite has expired',
                    });
                }

                // Check if the invite has already been used
                if (invite.usedAt) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'This invite has already been used',
                    });
                }

                // Only return the necessary information
                return {
                    email: invite.email || null,
                    role: invite.role,
                    communityName: invite.community.name,
                    orgId: invite.orgId || null,
                };
            } catch (error) {
                if (error instanceof TRPCError) {
                    throw error;
                }
                console.error('Error getting invite info:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to get invite information',
                });
            }
        }),

    // Join a community via invite link
    joinViaInvite: authProcedure
        .input(
            z.object({
                inviteCode: z.string(),
                // Add optional registration fields for new users
                registration: z
                    .object({
                        name: z.string().min(1),
                        password: z.string().min(8),
                    })
                    .optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            try {
                // Find the invite
                const invite = await db.query.communityInvites.findFirst({
                    where: eq(communityInvites.code, input.inviteCode),
                    with: {
                        community: true,
                    },
                });

                if (!invite) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Invalid invite code',
                    });
                }

                // Check if the invite has expired
                if (invite.expiresAt < new Date()) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'This invite has expired',
                    });
                }

                // Check if the invite has already been used
                if (invite.usedAt) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'This invite has already been used',
                    });
                }

                // Check if the user is already a member of the community
                const existingMembership =
                    await db.query.communityMembers.findFirst({
                        where: and(
                            eq(communityMembers.userId, ctx.session.user.id),
                            eq(
                                communityMembers.communityId,
                                invite.communityId,
                            ),
                        ),
                    });

                if (existingMembership) {
                    if (existingMembership.membershipType === 'member') {
                        throw new TRPCError({
                            code: 'BAD_REQUEST',
                            message:
                                'You are already a member of this community',
                        });
                    }

                    // Update membership from follower to member if needed
                    const [updatedMembership] = await db
                        .update(communityMembers)
                        .set({
                            membershipType: 'member',
                            role: invite.role,
                            status: 'active',
                            updatedAt: new Date(),
                        })
                        .where(
                            and(
                                eq(
                                    communityMembers.userId,
                                    ctx.session.user.id,
                                ),
                                eq(
                                    communityMembers.communityId,
                                    invite.communityId,
                                ),
                            ),
                        )
                        .returning();

                    // Mark the invite as used
                    await db
                        .update(communityInvites)
                        .set({
                            usedAt: new Date(),
                            usedBy: ctx.session.user.id,
                        })
                        .where(eq(communityInvites.id, invite.id));

                    return {
                        membership: updatedMembership,
                        community: invite.community,
                    };
                }

                // Create a new membership with the role from the invitation
                const [newMembership] = await db
                    .insert(communityMembers)
                    .values({
                        userId: ctx.session.user.id,
                        communityId: invite.communityId,
                        role: invite.role,
                        membershipType: 'member',
                        status: 'active',
                        joinedAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .returning();

                // Mark the invite as used
                await db
                    .update(communityInvites)
                    .set({
                        usedAt: new Date(),
                        usedBy: ctx.session.user.id,
                    })
                    .where(eq(communityInvites.id, invite.id));

                return {
                    membership: newMembership,
                    community: invite.community,
                };
            } catch (error) {
                if (error instanceof TRPCError) {
                    throw error;
                }
                console.error('Error joining community via invite:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to join community',
                });
            }
        }),

    // Send email invites to users for a community (admin and moderator)
    inviteUsersByEmail: publicProcedure
        .input(
            z.object({
                communityId: z.number(),
                emails: z.array(z.string().email()),
                role: z
                    .enum(['member', 'moderator', 'admin'])
                    .default('member'),
                senderName: z.string().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (!ctx.session?.user) {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'You must be logged in to send invites',
                });
            }

            // Check if user is super admin (appRole='admin')
            const isSuperAdmin = ctx.session.user.appRole === 'admin';

            // Check if the current user is an admin or moderator of the community
            const membership = await db.query.communityMembers.findFirst({
                where: and(
                    eq(communityMembers.userId, ctx.session.user.id),
                    eq(communityMembers.communityId, input.communityId),
                    or(
                        eq(communityMembers.role, 'admin'),
                        eq(communityMembers.role, 'moderator'),
                    ),
                ),
            });

            // Get community details to check org admin override
            const community = await db.query.communities.findFirst({
                where: eq(communities.id, input.communityId),
            });

            if (!community) {
                throw new TRPCError({
                    code: 'NOT_FOUND',
                    message: 'Community not found',
                });
            }

            // Check if user is org admin for this community
            const isOrgAdminForCommunityCheck = isOrgAdminForCommunity(
                ctx.session.user,
                community.orgId,
            );

            if (!membership && !isOrgAdminForCommunityCheck && !isSuperAdmin) {
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message:
                        'Only community admins, moderators, organization admins, or super admins can send invites',
                });
            }

            // Only admins can create moderator invites
            if (
                input.role === 'moderator' &&
                membership?.role !== 'admin' &&
                !isOrgAdminForCommunityCheck &&
                !isSuperAdmin
            ) {
                throw new TRPCError({
                    code: 'FORBIDDEN',
                    message:
                        'Only community admins, organization admins, or super admins can invite moderators',
                });
            }

            // Only users with admin management permissions can create admin invites
            if (input.role === 'admin') {
                // Super admins and org admins can always invite admin users
                if (!isOrgAdminForCommunityCheck && !isSuperAdmin) {
                    const permission = await ServerPermissions.fromUserId(
                        ctx.session.user.id,
                    );
                    const canAssignAdmin =
                        await permission.checkCommunityPermission(
                            input.communityId.toString(),
                            PERMISSIONS.ASSIGN_COMMUNITY_ADMIN,
                        );

                    if (!canAssignAdmin) {
                        throw new TRPCError({
                            code: 'FORBIDDEN',
                            message:
                                'You do not have permission to invite admin users',
                        });
                    }
                }
            }

            // Community details are already fetched above for org admin check

            // Get the current user's organization
            const currentUser = await db.query.users.findFirst({
                where: eq(users.id, ctx.session.user.id),
            });

            // Super admins can send invites without orgId, but regular users need an organization
            if (!isSuperAdmin && !currentUser?.orgId) {
                throw new TRPCError({
                    code: 'BAD_REQUEST',
                    message: 'User does not have an organization',
                });
            }

            try {
                const results: Array<{
                    email: string;
                    invite: typeof communityInvites.$inferSelect;
                    emailSent: boolean;
                }> = [];

                for (const email of input.emails) {
                    // Generate a unique code for this invite
                    const code = crypto.randomUUID();

                    // Calculate expiration date (7 days)
                    const expiresAt = new Date();
                    expiresAt.setDate(expiresAt.getDate() + 7);

                    // Create the invite record
                    const [invite] = await db
                        .insert(communityInvites)
                        .values({
                            communityId: input.communityId,
                            email,
                            code,
                            role: input.role,
                            orgId: currentUser?.orgId || community.orgId, // Use user's orgId or community's orgId for super admins
                            createdBy: ctx.session.user.id,
                            createdAt: new Date(),
                            expiresAt,
                        })
                        .returning();

                    // Generate the invite link
                    const inviteLink = `/communities/join/${code}`;
                    const fullInviteLink = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}${inviteLink}`;

                    // Determine the sender name to use
                    const senderName = input.senderName || community.name;

                    // Use the DEFAULT_EMAIL_FROM environment variable instead of SMTP_USER
                    const defaultFrom =
                        process.env.DEFAULT_EMAIL_FROM ||
                        'noreply@communities.app';

                    // Send the email directly to the recipient
                    const invitationEmail = createCommunityInvitationEmail(
                        community.name,
                        fullInviteLink,
                        input.role,
                    );

                    const emailResult = await sendEmail({
                        to: email,
                        subject: invitationEmail.subject,
                        from: senderName
                            ? `${senderName} <${defaultFrom}>`
                            : defaultFrom,
                        html: invitationEmail.html,
                    });

                    results.push({
                        email,
                        invite,
                        emailSent: emailResult.success,
                    });
                }

                return {
                    success: true,
                    count: results.length,
                    results,
                };
            } catch (error) {
                console.error('Error sending invites:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to send invites',
                });
            }
        }),

    searchRelevantPost: authProcedure
        .input(
            z.object({
                search: z.string().min(1),
                limit: z.number().min(1).max(100).default(10),
                offset: z.number().default(0),
                sort: z
                    .enum(['latest', 'oldest', 'most-commented'])
                    .default('latest'),
                dateFilter: z
                    .object({
                        type: z
                            .enum(['all', 'today', 'week', 'month', 'custom'])
                            .default('all'),
                        startDate: z.date().optional(),
                        endDate: z.date().optional(),
                    })
                    .optional()
                    .default({ type: 'all' }),
            }),
        )
        .query(async ({ ctx, input }) => {
            const { search, limit, offset, sort, dateFilter } = input;
            const userId = ctx.session.user.id;

            // Helper function to create date filter conditions
            const createDateFilter = () => {
                if (dateFilter.type === 'all') {
                    return undefined;
                }

                const now = new Date();
                let startDate: Date;
                let endDate: Date = now;

                switch (dateFilter.type) {
                    case 'today':
                        startDate = new Date(
                            now.getFullYear(),
                            now.getMonth(),
                            now.getDate(),
                        );
                        endDate = new Date(
                            now.getFullYear(),
                            now.getMonth(),
                            now.getDate(),
                            23,
                            59,
                            59,
                            999,
                        );
                        break;
                    case 'week':
                        startDate = new Date(
                            now.getTime() - 7 * 24 * 60 * 60 * 1000,
                        );
                        break;
                    case 'month':
                        startDate = new Date(
                            now.getTime() - 30 * 24 * 60 * 60 * 1000,
                        );
                        break;
                    case 'custom':
                        if (dateFilter.startDate && dateFilter.endDate) {
                            startDate = dateFilter.startDate;
                            endDate = dateFilter.endDate;
                        } else {
                            return undefined;
                        }
                        break;
                    default:
                        return undefined;
                }

                return and(
                    gte(posts.createdAt, startDate),
                    lte(posts.createdAt, endDate),
                );
            };

            const dateFilterCondition = createDateFilter();

            // Get user's org and communities
            const user = await db.query.users.findFirst({
                where: eq(users.id, userId),
                with: { organization: true },
            });
            const orgId = user?.orgId;
            if (!orgId) {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'User does not have an organization.',
                });
            }

            const memberships = await db.query.communityMembers.findMany({
                where: and(
                    eq(communityMembers.userId, userId),
                    eq(communityMembers.status, 'active'),
                ),
            });
            const communityIds = memberships.map((m) => m.communityId);

            // --- ORG ADMIN OVERRIDE ---
            // If the user is an org admin, include all communities in their org
            let orgAdminCommunityIds: number[] = [];
            if (user?.role === 'admin' && ctx.session.user.orgId) {
                orgAdminCommunityIds = await getCommunityIdsForOrg(
                    ctx.session.user.orgId,
                );
            }

            const accessibleCommunityIds = [
                ...new Set([...communityIds, ...orgAdminCommunityIds]),
            ];

            // Build search conditions using database-level filtering
            const searchTerm = `%${search.toLowerCase()}%`;

            // Create base conditions for posts the user can see
            const baseConditions = and(
                eq(posts.isDeleted, false),
                or(
                    // User's org posts
                    eq(posts.orgId, orgId),
                    // Community posts user has access to
                    accessibleCommunityIds.length > 0
                        ? inArray(posts.communityId, accessibleCommunityIds)
                        : sql`false`,
                ),
            );

            // Add search conditions - use database-level text search for better performance
            const searchConditions = dateFilterCondition
                ? and(
                      baseConditions,
                      or(
                          ilike(posts.title, searchTerm),
                          ilike(posts.content, searchTerm),
                      ),
                      dateFilterCondition,
                  )
                : and(
                      baseConditions,
                      or(
                          ilike(posts.title, searchTerm),
                          ilike(posts.content, searchTerm),
                      ),
                  );

            // Get total count for pagination
            const totalCountResult = await db
                .select({ count: sql<number>`count(*)` })
                .from(posts)
                .where(searchConditions);

            const totalCount = totalCountResult[0]?.count || 0;

            // Determine order by clause based on sort option
            let orderByClause;
            if (sort === 'most-commented') {
                // For comment count sorting, we need to use a subquery
                orderByClause = sql`(
                    SELECT COUNT(*) FROM comments c 
                    WHERE c.post_id = posts.id AND c.is_deleted = false
                ) DESC`;
            } else {
                orderByClause =
                    sort === 'latest'
                        ? desc(posts.createdAt)
                        : asc(posts.createdAt);
            }

            // Fetch paginated results with all necessary relations
            const searchResults = await db.query.posts.findMany({
                where: searchConditions,
                with: {
                    author: {
                        with: {
                            organization: true,
                        },
                    },
                    community: true,
                    postTags: {
                        with: {
                            tag: true,
                        },
                    },
                    comments: true, // Include comments for count
                },
                orderBy: orderByClause,
                limit: limit,
                offset: offset,
            });

            // Transform the results to match your PostDisplay type
            const transformedPosts = searchResults.map((post) => ({
                ...post,
                // Add source information based on post type
                source: post.communityId
                    ? {
                          type: 'community' as const,
                          communityId: post.communityId,
                          reason: `from ${post.community?.name || 'your community'}`,
                      }
                    : {
                          type: 'org' as const,
                          orgId: post.orgId,
                          reason: `from ${(post.author as any)?.organization?.name || 'your organization'}`,
                      },
                // Transform tags to match PostTag type
                tags:
                    post.postTags?.map((pt) => ({
                        id: pt.tag.id,
                        name: pt.tag.name,
                        color: undefined, // Add color if you have it in your tag schema
                    })) || [],
            }));

            return {
                posts: transformedPosts,
                totalCount,
                hasNextPage: offset + limit < totalCount,
                nextOffset: offset + limit < totalCount ? offset + limit : null,
            };
        }),

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
                    };
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

                // Check if post exists
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
                    };
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
        .input(z.object({ postIds: z.array(z.number()) }))
        .query(async ({ input, ctx }) => {
            try {
                const userId = ctx.session.user.id;
                const { postIds } = input;

                if (postIds.length === 0) {
                    return {};
                }

                const userReactions = await db.query.reactions.findMany({
                    where: and(
                        inArray(reactions.postId, postIds),
                        eq(reactions.userId, userId),
                        eq(reactions.type, 'like'),
                    ),
                    columns: {
                        postId: true,
                    },
                });

                // Convert to a map for easy lookup
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
        .input(z.object({ postIds: z.array(z.number()) }))
        .query(async ({ input }) => {
            try {
                const { postIds } = input;

                if (postIds.length === 0) {
                    return {};
                }

                const likeCounts = await db
                    .select({
                        postId: reactions.postId,
                        count: count(),
                    })
                    .from(reactions)
                    .where(
                        and(
                            inArray(reactions.postId, postIds),
                            eq(reactions.type, 'like'),
                        ),
                    )
                    .groupBy(reactions.postId);

                // Convert to a map for easy lookup
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
});
