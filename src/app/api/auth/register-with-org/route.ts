import { NextResponse } from 'next/server';
import { db } from '@/server/db';
import { users, accounts, verifications, orgs } from '@/server/db/auth-schema';
import { nanoid } from 'nanoid';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { sendEmail } from '@/lib/email';
import { createWelcomeEmail } from '@/lib/email-templates';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { email, password, name, orgId, role = 'user', token } = body;

        if (!email || !password || !name || !orgId) {
            return NextResponse.json(
                { error: 'Missing required fields' },
                { status: 400 },
            );
        }

        // Verify the organization exists
        const organization = await db.query.orgs.findFirst({
            where: eq(orgs.id, orgId),
        });

        if (!organization) {
            return NextResponse.json(
                { error: 'Organization not found' },
                { status: 404 },
            );
        }

        // Check if token is provided, verify it
        if (token) {
            // Get all verification records for this email
            const allVerifications = await db.query.verifications.findMany({
                where: eq(verifications.identifier, email),
            });

            if (allVerifications.length === 0) {
                return NextResponse.json(
                    { error: 'No invitation found for this email' },
                    { status: 400 },
                );
            }

            // Try to find a matching token in any of the verification records
            let tokenFound = false;

            for (const verification of allVerifications) {
                try {
                    const parsedValue = JSON.parse(verification.value);

                    if (parsedValue.token === token) {
                        tokenFound = true;
                        break;
                    }
                } catch (e) {
                    console.error('Error parsing verification value:', e);
                    // Continue checking other records
                }
            }

            if (!tokenFound) {
                return NextResponse.json(
                    { error: 'Invalid invitation token' },
                    { status: 400 },
                );
            }
        }

        // Check if user already exists
        const existingUser = await db.query.users.findFirst({
            where: eq(users.email, email),
        });

        if (existingUser) {
            return NextResponse.json(
                { error: 'User already exists' },
                { status: 409 },
            );
        }

        // Create the user
        const userId = nanoid();
        const now = new Date();
        const hashedPassword = await hashPassword(password);

        // Insert user with explicit orgId
        const [newUser] = await db
            .insert(users)
            .values({
                id: userId,
                name,
                email,
                emailVerified: true,
                orgId,
                role,
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

        // Send welcome email
        try {
            const welcomeEmail = createWelcomeEmail(
                `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login`,
            );
            await sendEmail({
                to: newUser.email,
                subject: welcomeEmail.subject,
                html: welcomeEmail.html,
            });
            console.log(`Welcome email sent to ${newUser.email}`);
        } catch (emailError) {
            console.error('Failed to send welcome email:', emailError);
            // Don't fail the registration if email fails
        }

        // Return success
        return NextResponse.json({
            success: true,
            user: {
                id: newUser.id,
                name: newUser.name,
                email: newUser.email,
                orgId: newUser.orgId,
                role: newUser.role,
            },
        });
    } catch (error) {
        console.error('Error during registration:', error);
        return NextResponse.json(
            { error: 'Registration failed' },
            { status: 500 },
        );
    }
}
