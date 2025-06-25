'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/providers/trpc-provider';
import { useSession } from '@/server/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Loader2, CheckCircle, UserMinus } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
    CartesianGrid,
} from 'recharts';

// Define types for the data we're working with
type User = {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    orgId: string;
    organization?: {
        id: string;
        name: string;
    };
    role: string;
    createdAt: string | Date;
    updatedAt: string | Date;
};

type Organization = {
    id: string;
    name: string;
};

export default function AdminDashboard() {
    const router = useRouter();
    const { data: session } = useSession();
    const [activeTab, setActiveTab] = useState('users');
    const [isClient, setIsClient] = useState(false);

    // State for user removal alert dialog
    const [isRemoveUserDialogOpen, setIsRemoveUserDialogOpen] = useState(false);
    const [userToRemove, setUserToRemove] = useState<string | null>(null);

    // State for create user dialog
    const [isCreateUserDialogOpen, setIsCreateUserDialogOpen] = useState(false);
    const [newUser, setNewUser] = useState({
        name: '',
        email: '',
        password: '',
        role: 'user' as 'admin' | 'user',
        orgId: '',
    });

    // State for create org dialog
    const [isCreateOrgDialogOpen, setIsCreateOrgDialogOpen] = useState(false);
    const [newOrg, setNewOrg] = useState({
        name: '',
    });

    // State for invite user dialog
    const [isInviteUserDialogOpen, setIsInviteUserDialogOpen] = useState(false);
    const [inviteUser, setInviteUser] = useState({
        email: '',
        role: 'user' as 'admin' | 'user',
        orgId: '',
    });

    // Queries
    const { data: users, isLoading: isLoadingUsers } =
        trpc.admin.getUsers.useQuery(undefined, {
            enabled: !!session && session.user.role === 'admin',
        });

    const { data: orgs, isLoading: isLoadingOrgs } =
        trpc.admin.getOrgs.useQuery(undefined, {
            enabled: !!session && session.user.role === 'admin',
        });

    // Fetch unique logins per day
    const { data: uniqueLogins, isLoading: isLoadingLogins } =
        trpc.admin.getUniqueLoginsPerDay.useQuery(undefined, {
            enabled: !!session && session.user.role === 'admin',
        });

    // Mutations
    const createUserMutation = trpc.admin.createUser.useMutation({
        onSuccess: () => {
            setIsCreateUserDialogOpen(false);
            setNewUser({
                name: '',
                email: '',
                password: '',
                role: 'user' as 'admin' | 'user',
                orgId: '',
            });
            utils.admin.getUsers.invalidate();
        },
    });

    const createOrgMutation = trpc.admin.createOrg.useMutation({
        onSuccess: () => {
            setIsCreateOrgDialogOpen(false);
            setNewOrg({
                name: '',
            });
            utils.admin.getOrgs.invalidate();
        },
    });

    const inviteUserMutation = trpc.admin.inviteUser.useMutation({
        onSuccess: () => {
            setIsInviteUserDialogOpen(false);
            setInviteUser({
                email: '',
                role: 'user' as 'admin' | 'user',
                orgId: '',
            });
        },
    });

    const removeUserMutation = trpc.admin.removeUser.useMutation({
        onSuccess: () => {
            utils.admin.getUsers.invalidate();
        },
    });

    const utils = trpc.useUtils();

    // Handle form submissions
    const handleCreateUser = (e: React.FormEvent) => {
        e.preventDefault();
        createUserMutation.mutate(newUser);
    };

    const handleCreateOrg = (e: React.FormEvent) => {
        e.preventDefault();
        createOrgMutation.mutate(newOrg);
    };

    const handleInviteUser = (e: React.FormEvent) => {
        e.preventDefault();
        inviteUserMutation.mutate(inviteUser);
    };

    // Updated to open the alert dialog instead of using browser confirm
    const handleRemoveUser = (userId: string) => {
        // Prevent admins from removing themselves
        if (userId === session?.user.id) {
            toast.error('You cannot remove yourself from the platform');
            return;
        }

        setUserToRemove(userId);
        setIsRemoveUserDialogOpen(true);
    };

    // Actual removal function called from the alert dialog
    const confirmRemoveUser = () => {
        if (userToRemove) {
            removeUserMutation.mutate({ userId: userToRemove });
            setIsRemoveUserDialogOpen(false);
            setUserToRemove(null);
        }
    };

    // Use useEffect for navigation instead of doing it during render
    useEffect(() => {
        setIsClient(true);
    }, []);

    // Don't render anything meaningful during SSR to avoid hydration mismatches
    if (!isClient) {
        return <div>Loading...</div>;
    }

    // Check if user is admin
    if (session === undefined) {
        return <div>Loading...</div>;
    }

    if (!session) {
        return (
            <div className="container mx-auto px-4 py-16 text-center">
                <h1 className="mb-4 text-3xl font-bold">
                    Authentication Required
                </h1>
                <p className="text-muted-foreground mb-8">
                    Please sign in to access the admin dashboard.
                </p>
                <Button asChild>
                    <Link href="/auth/login">Sign In</Link>
                </Button>
            </div>
        );
    }

    if (session.user.role !== 'admin') {
        return (
            <div className="container mx-auto p-4">
                <h1 className="mb-4 text-2xl font-bold">Access Denied</h1>
                <p>You do not have permission to access this page.</p>
            </div>
        );
    }

    return (
        <div className="container mx-auto p-4">
            <h1 className="mb-6 text-3xl font-bold">Admin Dashboard</h1>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-4">
                    <TabsTrigger value="users">Users</TabsTrigger>
                    <TabsTrigger value="organizations">
                        Organizations
                    </TabsTrigger>
                    <TabsTrigger value="tools">Admin Tools</TabsTrigger>
                </TabsList>

                <TabsContent value="users">
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <CardTitle>User Management</CardTitle>
                                <div className="space-x-2">
                                    <Dialog
                                        open={isInviteUserDialogOpen}
                                        onOpenChange={setIsInviteUserDialogOpen}
                                    >
                                        <DialogTrigger asChild>
                                            <Button variant="outline">
                                                Invite User
                                            </Button>
                                        </DialogTrigger>
                                        <DialogContent>
                                            <form onSubmit={handleInviteUser}>
                                                <DialogHeader>
                                                    <DialogTitle>
                                                        Invite User
                                                    </DialogTitle>
                                                    <DialogDescription>
                                                        Send an invitation email
                                                        to a new user.
                                                    </DialogDescription>
                                                </DialogHeader>
                                                <div className="grid gap-4 py-4">
                                                    <div className="grid grid-cols-4 items-center gap-4">
                                                        <Label
                                                            htmlFor="invite-email"
                                                            className="text-right"
                                                        >
                                                            Email
                                                        </Label>
                                                        <Input
                                                            id="invite-email"
                                                            type="email"
                                                            value={
                                                                inviteUser.email
                                                            }
                                                            onChange={(e) =>
                                                                setInviteUser({
                                                                    ...inviteUser,
                                                                    email: e
                                                                        .target
                                                                        .value,
                                                                })
                                                            }
                                                            className="col-span-3"
                                                            required
                                                        />
                                                    </div>
                                                    <div className="grid grid-cols-4 items-center gap-4">
                                                        <Label
                                                            htmlFor="invite-role"
                                                            className="text-right"
                                                        >
                                                            Role
                                                        </Label>
                                                        <Select
                                                            value={
                                                                inviteUser.role
                                                            }
                                                            onValueChange={(
                                                                value: string,
                                                            ) =>
                                                                setInviteUser({
                                                                    ...inviteUser,
                                                                    role: value as
                                                                        | 'admin'
                                                                        | 'user',
                                                                })
                                                            }
                                                        >
                                                            <SelectTrigger className="col-span-3">
                                                                <SelectValue placeholder="Select role" />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="user">
                                                                    User
                                                                </SelectItem>
                                                                <SelectItem value="admin">
                                                                    Admin
                                                                </SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                    <div className="grid grid-cols-4 items-center gap-4">
                                                        <Label
                                                            htmlFor="invite-org"
                                                            className="text-right"
                                                        >
                                                            Organization
                                                        </Label>
                                                        <Select
                                                            value={
                                                                inviteUser.orgId
                                                            }
                                                            onValueChange={(
                                                                value: string,
                                                            ) =>
                                                                setInviteUser({
                                                                    ...inviteUser,
                                                                    orgId: value,
                                                                })
                                                            }
                                                        >
                                                            <SelectTrigger className="col-span-3">
                                                                <SelectValue placeholder="Select organization" />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                {orgs?.map(
                                                                    (
                                                                        org: Organization,
                                                                    ) => (
                                                                        <SelectItem
                                                                            key={
                                                                                org.id
                                                                            }
                                                                            value={
                                                                                org.id
                                                                            }
                                                                        >
                                                                            {
                                                                                org.name
                                                                            }
                                                                        </SelectItem>
                                                                    ),
                                                                )}
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                </div>
                                                <DialogFooter>
                                                    <Button
                                                        type="submit"
                                                        disabled={
                                                            inviteUserMutation.isPending
                                                        }
                                                    >
                                                        {inviteUserMutation.isPending
                                                            ? 'Sending...'
                                                            : 'Send Invitation'}
                                                    </Button>
                                                </DialogFooter>
                                            </form>
                                        </DialogContent>
                                    </Dialog>

                                    <Dialog
                                        open={isCreateUserDialogOpen}
                                        onOpenChange={setIsCreateUserDialogOpen}
                                    >
                                        <DialogTrigger asChild>
                                            <Button>Create User</Button>
                                        </DialogTrigger>
                                        <DialogContent>
                                            <form onSubmit={handleCreateUser}>
                                                <DialogHeader>
                                                    <DialogTitle>
                                                        Create User
                                                    </DialogTitle>
                                                    <DialogDescription>
                                                        Create a new user
                                                        account.
                                                    </DialogDescription>
                                                </DialogHeader>
                                                <div className="grid gap-4 py-4">
                                                    <div className="grid grid-cols-4 items-center gap-4">
                                                        <Label
                                                            htmlFor="name"
                                                            className="text-right"
                                                        >
                                                            Name
                                                        </Label>
                                                        <Input
                                                            id="name"
                                                            value={newUser.name}
                                                            onChange={(e) =>
                                                                setNewUser({
                                                                    ...newUser,
                                                                    name: e
                                                                        .target
                                                                        .value,
                                                                })
                                                            }
                                                            className="col-span-3"
                                                            required
                                                        />
                                                    </div>
                                                    <div className="grid grid-cols-4 items-center gap-4">
                                                        <Label
                                                            htmlFor="email"
                                                            className="text-right"
                                                        >
                                                            Email
                                                        </Label>
                                                        <Input
                                                            id="email"
                                                            type="email"
                                                            value={
                                                                newUser.email
                                                            }
                                                            onChange={(e) =>
                                                                setNewUser({
                                                                    ...newUser,
                                                                    email: e
                                                                        .target
                                                                        .value,
                                                                })
                                                            }
                                                            className="col-span-3"
                                                            required
                                                        />
                                                    </div>
                                                    <div className="grid grid-cols-4 items-center gap-4">
                                                        <Label
                                                            htmlFor="password"
                                                            className="text-right"
                                                        >
                                                            Password
                                                        </Label>
                                                        <Input
                                                            id="password"
                                                            type="password"
                                                            value={
                                                                newUser.password
                                                            }
                                                            onChange={(e) =>
                                                                setNewUser({
                                                                    ...newUser,
                                                                    password:
                                                                        e.target
                                                                            .value,
                                                                })
                                                            }
                                                            className="col-span-3"
                                                            required
                                                            minLength={8}
                                                        />
                                                    </div>
                                                    <div className="grid grid-cols-4 items-center gap-4">
                                                        <Label
                                                            htmlFor="role"
                                                            className="text-right"
                                                        >
                                                            Role
                                                        </Label>
                                                        <Select
                                                            value={newUser.role}
                                                            onValueChange={(
                                                                value: string,
                                                            ) =>
                                                                setNewUser({
                                                                    ...newUser,
                                                                    role: value as
                                                                        | 'admin'
                                                                        | 'user',
                                                                })
                                                            }
                                                        >
                                                            <SelectTrigger className="col-span-3">
                                                                <SelectValue placeholder="Select role" />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="user">
                                                                    User
                                                                </SelectItem>
                                                                <SelectItem value="admin">
                                                                    Admin
                                                                </SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                    <div className="grid grid-cols-4 items-center gap-4">
                                                        <Label
                                                            htmlFor="org"
                                                            className="text-right"
                                                        >
                                                            Organization
                                                        </Label>
                                                        <Select
                                                            value={
                                                                newUser.orgId
                                                            }
                                                            onValueChange={(
                                                                value: string,
                                                            ) =>
                                                                setNewUser({
                                                                    ...newUser,
                                                                    orgId: value,
                                                                })
                                                            }
                                                        >
                                                            <SelectTrigger className="col-span-3">
                                                                <SelectValue placeholder="Select organization" />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                {orgs?.map(
                                                                    (
                                                                        org: Organization,
                                                                    ) => (
                                                                        <SelectItem
                                                                            key={
                                                                                org.id
                                                                            }
                                                                            value={
                                                                                org.id
                                                                            }
                                                                        >
                                                                            {
                                                                                org.name
                                                                            }
                                                                        </SelectItem>
                                                                    ),
                                                                )}
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                </div>
                                                <DialogFooter>
                                                    <Button
                                                        type="submit"
                                                        disabled={
                                                            createUserMutation.isPending
                                                        }
                                                    >
                                                        {createUserMutation.isPending
                                                            ? 'Creating...'
                                                            : 'Create User'}
                                                    </Button>
                                                </DialogFooter>
                                            </form>
                                        </DialogContent>
                                    </Dialog>
                                </div>
                            </div>
                            <CardDescription>
                                Manage users, create new accounts, and send
                                invitations.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {isLoadingUsers ? (
                                <div className="py-4 text-center">
                                    Loading users...
                                </div>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Name</TableHead>
                                            <TableHead>Email</TableHead>
                                            <TableHead>Role</TableHead>
                                            <TableHead>Organization</TableHead>
                                            <TableHead>Verified</TableHead>
                                            <TableHead>Created</TableHead>
                                            <TableHead>Actions</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {users?.map((user: User) => (
                                            <TableRow key={user.id}>
                                                <TableCell>
                                                    {user.name}
                                                </TableCell>
                                                <TableCell>
                                                    {user.email}
                                                </TableCell>
                                                <TableCell>
                                                    {user.role}
                                                </TableCell>
                                                <TableCell>
                                                    {user.organization?.name ||
                                                        user.orgId}
                                                </TableCell>
                                                <TableCell>
                                                    {user.emailVerified
                                                        ? 'Yes'
                                                        : 'No'}
                                                </TableCell>
                                                <TableCell>
                                                    {new Date(
                                                        user.createdAt,
                                                    ).toLocaleDateString()}
                                                </TableCell>
                                                <TableCell>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() =>
                                                            handleRemoveUser(
                                                                user.id,
                                                            )
                                                        }
                                                        disabled={
                                                            user.id ===
                                                            session.user.id
                                                        }
                                                        title={
                                                            user.id ===
                                                            session.user.id
                                                                ? 'You cannot remove yourself'
                                                                : 'Kick user'
                                                        }
                                                    >
                                                        <UserMinus className="h-4 w-4" />
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="organizations">
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <CardTitle>Organization Management</CardTitle>
                                <Dialog
                                    open={isCreateOrgDialogOpen}
                                    onOpenChange={setIsCreateOrgDialogOpen}
                                >
                                    <DialogTrigger asChild>
                                        <Button>Create Organization</Button>
                                    </DialogTrigger>
                                    <DialogContent>
                                        <form onSubmit={handleCreateOrg}>
                                            <DialogHeader>
                                                <DialogTitle>
                                                    Create Organization
                                                </DialogTitle>
                                                <DialogDescription>
                                                    Create a new organization.
                                                </DialogDescription>
                                            </DialogHeader>
                                            <div className="grid gap-4 py-4">
                                                <div className="grid grid-cols-4 items-center gap-4">
                                                    <Label
                                                        htmlFor="org-name"
                                                        className="text-right"
                                                    >
                                                        Name
                                                    </Label>
                                                    <Input
                                                        id="org-name"
                                                        value={newOrg.name}
                                                        onChange={(e) =>
                                                            setNewOrg({
                                                                ...newOrg,
                                                                name: e.target
                                                                    .value,
                                                            })
                                                        }
                                                        className="col-span-3"
                                                        required
                                                    />
                                                </div>
                                            </div>
                                            <DialogFooter>
                                                <Button
                                                    type="submit"
                                                    disabled={
                                                        createOrgMutation.isPending
                                                    }
                                                >
                                                    {createOrgMutation.isPending
                                                        ? 'Creating...'
                                                        : 'Create Organization'}
                                                </Button>
                                            </DialogFooter>
                                        </form>
                                    </DialogContent>
                                </Dialog>
                            </div>
                            <CardDescription>
                                Manage organizations and create new ones.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {isLoadingOrgs ? (
                                <div className="py-4 text-center">
                                    Loading organizations...
                                </div>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>ID</TableHead>
                                            <TableHead>Name</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {orgs?.map((org: Organization) => (
                                            <TableRow key={org.id}>
                                                <TableCell>{org.id}</TableCell>
                                                <TableCell>
                                                    {org.name}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="tools">
                    <div className="grid gap-6 md:grid-cols-2">
                        {/* Unique Logins Card */}
                        <Card>
                            <CardHeader>
                                <CardTitle>Unique Logins Per Day</CardTitle>
                                <CardDescription>
                                    Number of unique users who logged in each
                                    day (last 30 days)
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                {isLoadingLogins ? (
                                    <div className="py-4 text-center">
                                        Loading login stats...
                                    </div>
                                ) : uniqueLogins && uniqueLogins.length > 0 ? (
                                    <>
                                        <div
                                            style={{
                                                width: '100%',
                                                height: 300,
                                            }}
                                        >
                                            <ResponsiveContainer
                                                width="100%"
                                                height={300}
                                            >
                                                <BarChart
                                                    data={[
                                                        ...uniqueLogins,
                                                    ].reverse()}
                                                    margin={{
                                                        top: 16,
                                                        right: 16,
                                                        left: 0,
                                                        bottom: 0,
                                                    }}
                                                >
                                                    <CartesianGrid strokeDasharray="3 3" />
                                                    <XAxis
                                                        dataKey="date"
                                                        tick={{ fontSize: 12 }}
                                                    />
                                                    <YAxis
                                                        allowDecimals={false}
                                                    />
                                                    <Tooltip />
                                                    <Bar
                                                        dataKey="unique_logins"
                                                        fill="#6366f1"
                                                    />
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                        <Table className="mt-6">
                                            <TableHeader>
                                                <TableRow>
                                                    <TableHead>Date</TableHead>
                                                    <TableHead>
                                                        Unique Logins
                                                    </TableHead>
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {uniqueLogins.map(
                                                    (row: any) => (
                                                        <TableRow
                                                            key={row.date}
                                                        >
                                                            <TableCell>
                                                                {row.date}
                                                            </TableCell>
                                                            <TableCell>
                                                                {
                                                                    row.unique_logins
                                                                }
                                                            </TableCell>
                                                        </TableRow>
                                                    ),
                                                )}
                                            </TableBody>
                                        </Table>
                                    </>
                                ) : (
                                    <div className="py-4 text-center">
                                        No login data available.
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>
            </Tabs>

            {/* Remove User Alert Dialog */}
            <AlertDialog
                open={isRemoveUserDialogOpen}
                onOpenChange={setIsRemoveUserDialogOpen}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Kick User</AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to remove this user? This
                            action cannot be undone and will delete the user's
                            account, community memberships, and all associated
                            data.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={confirmRemoveUser}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            Kick User
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
