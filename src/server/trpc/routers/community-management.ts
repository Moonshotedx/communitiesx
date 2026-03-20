import { z } from 'zod';
import { authProcedure, publicProcedure } from '../trpc';
import { db } from '@/server/db';
import { TRPCError } from '@trpc/server';
import {
    communities,
    communityMembers,
    communityAllowedOrgs,
    users,
} from '@/server/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { ServerPermissions } from '@/server/utils/permission';
import { PERMISSIONS } from '@/lib/permissions/permission-const';

export const managementProcedures = {
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
                // Handle unique constraint violation on slug (race condition safety net)
                if (
                    error instanceof Error &&
                    'code' in error &&
                    (error as any).code === '23505'
                ) {
                    throw new TRPCError({
                        code: 'BAD_REQUEST',
                        message: 'Community URL is already taken',
                    });
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
};
