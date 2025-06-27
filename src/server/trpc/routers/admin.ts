import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { users, orgs, accounts, verifications } from '@/server/db/auth-schema';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { nanoid } from 'nanoid';
import { sendEmail } from '@/lib/email';
import { hashPassword } from 'better-auth/crypto';
import { communityMembers } from '@/server/db/schema';

export const adminRouter = router({
    // Get all users
    getUsers: publicProcedure.query(async ({ ctx }) => {
        if (!ctx.session?.user || ctx.session.user.role !== 'admin') {
            throw new TRPCError({
                code: 'UNAUTHORIZED',
                message: 'Only admins can access user management',
            });
        }

        try {
            const allUsers = await db.query.users.findMany({
                with: {
                    organization: true,
                },
            });

            return allUsers;
        } catch (error) {
            console.error('Error fetching users:', error);
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to fetch users',
            });
        }
    }),

    // Get all organizations
    getOrgs: publicProcedure.query(async ({ ctx }) => {
        if (!ctx.session?.user || ctx.session.user.role !== 'admin') {
            throw new TRPCError({
                code: 'UNAUTHORIZED',
                message: 'Only admins can access organization management',
            });
        }

        try {
            const allOrgs = await db.query.orgs.findMany();
            return allOrgs;
        } catch (error) {
            console.error('Error fetching organizations:', error);
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to fetch organizations',
            });
        }
    }),

    // Create a new organization
    createOrg: publicProcedure
        .input(
            z.object({
                name: z.string().min(1),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (!ctx.session?.user || ctx.session.user.role !== 'admin') {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'Only admins can create organizations',
                });
            }

            try {
                // Check if org with same name exists
                const existingOrg = await db.query.orgs.findFirst({
                    where: eq(orgs.name, input.name),
                });

                if (existingOrg) {
                    throw new TRPCError({
                        code: 'CONFLICT',
                        message:
                            'An organization with this name already exists',
                    });
                }

                const orgId = nanoid();
                const [newOrg] = await db
                    .insert(orgs)
                    .values({
                        id: orgId,
                        name: input.name,
                    })
                    .returning();

                return newOrg;
            } catch (error) {
                if (error instanceof TRPCError) throw error;
                console.error('Error creating organization:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to create organization',
                });
            }
        }),

    // Create a new user
    createUser: publicProcedure
        .input(
            z.object({
                name: z.string().min(1),
                email: z.string().email(),
                password: z.string().min(8),
                role: z.enum(['admin', 'user']),
                orgId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (!ctx.session?.user || ctx.session.user.role !== 'admin') {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'Only admins can create users',
                });
            }

            try {
                // Check if org exists
                const org = await db.query.orgs.findFirst({
                    where: eq(orgs.id, input.orgId),
                });

                if (!org) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Organization not found',
                    });
                }

                // Check if user with same email exists
                const existingUser = await db.query.users.findFirst({
                    where: eq(users.email, input.email),
                });

                if (existingUser) {
                    throw new TRPCError({
                        code: 'CONFLICT',
                        message: 'A user with this email already exists',
                    });
                }

                // Create user manually
                const userId = nanoid();
                const now = new Date();

                // Hash the password
                const hashedPassword = await hashPassword(input.password);

                // Create the user
                const [user] = await db
                    .insert(users)
                    .values({
                        id: userId,
                        name: input.name,
                        email: input.email,
                        emailVerified: true, // Admin-created users are pre-verified
                        orgId: input.orgId,
                        role: input.role,
                        createdAt: now,
                        updatedAt: now,
                    })
                    .returning();

                // Create account with password
                await db.insert(accounts).values({
                    id: nanoid(),
                    userId: userId,
                    providerId: 'credential',
                    accountId: userId,
                    password: hashedPassword,
                    createdAt: now,
                    updatedAt: now,
                });

                return user;
            } catch (error) {
                if (error instanceof TRPCError) throw error;
                console.error('Error creating user:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to create user',
                });
            }
        }),

    // Send invite to a user
    inviteUser: publicProcedure
        .input(
            z.object({
                email: z.string().email(),
                orgId: z.string(),
                role: z.enum(['admin', 'user']),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (!ctx.session?.user || ctx.session.user.role !== 'admin') {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'Only admins can invite users',
                });
            }

            try {
                // Check if org exists
                const org = await db.query.orgs.findFirst({
                    where: eq(orgs.id, input.orgId),
                });

                if (!org) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'Organization not found',
                    });
                }

                // Check if user already exists
                const existingUser = await db.query.users.findFirst({
                    where: eq(users.email, input.email),
                });

                if (existingUser) {
                    throw new TRPCError({
                        code: 'CONFLICT',
                        message: 'A user with this email already exists',
                    });
                }

                // Generate a unique invite token
                const inviteToken = nanoid(32);
                const now = new Date();
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

                // Store invite in verifications table
                await db.insert(verifications).values({
                    id: nanoid(),
                    identifier: input.email,
                    value: JSON.stringify({
                        token: inviteToken,
                        orgId: input.orgId,
                        role: input.role,
                    }),
                    expiresAt,
                    createdAt: now,
                    updatedAt: now,
                });

                // Send the invite email
                const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/auth/register?token=${inviteToken}&email=${input.email}`;

                await sendEmail({
                    to: input.email,
                    subject: `Invitation to join ${org.name}`,
                    html: `
                        <h1>You've been invited to join ${org.name}</h1>
                        <p>Click the link below to create your account:</p>
                        <a href="${inviteUrl}">Accept Invitation</a>
                        <p>This link will expire in 7 days.</p>
                    `,
                });

                return { success: true, email: input.email };
            } catch (error) {
                console.error('Error inviting user:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to send invitation',
                });
            }
        }),

    // Remove a user from the platform
    removeUser: publicProcedure
        .input(
            z.object({
                userId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (!ctx.session?.user || ctx.session.user.role !== 'admin') {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: 'Only admins can remove users',
                });
            }

            try {
                // Check if user exists
                const user = await db.query.users.findFirst({
                    where: eq(users.id, input.userId),
                });

                if (!user) {
                    throw new TRPCError({
                        code: 'NOT_FOUND',
                        message: 'User not found',
                    });
                }

                // Don't allow admins to remove themselves
                if (user.id === ctx.session.user.id) {
                    throw new TRPCError({
                        code: 'FORBIDDEN',
                        message: 'You cannot remove yourself',
                    });
                }

                // Remove user's community memberships
                await db
                    .delete(communityMembers)
                    .where(eq(communityMembers.userId, input.userId));

                // Remove user's accounts
                await db
                    .delete(accounts)
                    .where(eq(accounts.userId, input.userId));

                // Finally remove the user
                await db.delete(users).where(eq(users.id, input.userId));

                return { success: true };
            } catch (error) {
                if (error instanceof TRPCError) throw error;
                console.error('Error removing user:', error);
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to remove user',
                });
            }
        }),

    // Get unique logins per day from login_events
    getUniqueLoginsPerDay: publicProcedure.query(async ({ ctx }) => {
        if (!ctx.session?.user || ctx.session.user.role !== 'admin') {
            throw new TRPCError({
                code: 'UNAUTHORIZED',
                message: 'Only admins can access login stats',
            });
        }
        try {
            const result = await db.execute(
                `SELECT DATE("created_at") as date, COUNT(DISTINCT "user_id") as unique_logins
                 FROM login_events
                 GROUP BY DATE("created_at")
                 ORDER BY date DESC
                 LIMIT 30;`,
            );
            return result.rows;
        } catch (error) {
            console.error('Error fetching unique logins per day:', error);
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to fetch unique logins per day',
            });
        }
    }),
});
