'use client';

import { TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Building,
    Users,
    Plus,
    MessageSquare,
    Edit,
    Trash2,
} from 'lucide-react';
import { ShareButton } from '@/components/ui/share-button';
import { LikeButton } from '@/components/ui/like-button';
import Link from 'next/link';
import { UserProfilePopover } from '@/components/ui/user-profile-popover';
import { SafeHtml } from '@/lib/sanitize';
import { DateFilter, type DateFilterState } from '@/components/date-filter';
import { trpc } from '@/providers/trpc-provider';
import { useSession } from '@/server/auth/client';
import { useMemo, useEffect, useState, useCallback } from 'react';

interface CommunityPostsProps {
    community: any;
    isLoading: boolean;
    isMember: boolean;
    canCreatePost: boolean;
    filteredPosts: any[];
    showMyPosts: boolean;
    selectedTagFilters: number[];
    dateFilter: DateFilterState;
    onDateFilterChange: (filter: DateFilterState) => void;
    onPostFilterToggle: () => void;
    onTagFilterToggle: (tagId: number) => void;
    onClearTagFilters: () => void;
    onClearPostFilter: () => void;
    onDeletePost: (postId: number, e: React.MouseEvent) => void;
    canEditPost: (post: any) => boolean;
    canDeletePost: (post: any) => boolean;
    router: any;
}

export function CommunityPosts({
    community,
    isLoading,
    isMember,
    canCreatePost,
    filteredPosts,
    showMyPosts,
    selectedTagFilters,
    dateFilter,
    onDateFilterChange,
    onPostFilterToggle,
    onTagFilterToggle,
    onClearTagFilters,
    onClearPostFilter,
    onDeletePost,
    canEditPost,
    canDeletePost,
    router,
}: CommunityPostsProps) {
    const sessionData = useSession();
    const session = sessionData.data;
    const [postsWithLikes, setPostsWithLikes] = useState<any[]>([]);
    const utils = trpc.useUtils();

    // Get like counts for all posts
    const postIds = useMemo(
        () => filteredPosts.map((post) => post.id),
        [filteredPosts],
    );
    const likeCountsQuery = trpc.community.getPostLikeCounts.useQuery(
        { postIds },
        {
            enabled: postIds.length > 0,
            staleTime: 0, // Always fetch fresh data
            refetchOnWindowFocus: true,
            refetchInterval: 5 * 1000, // More frequent polling to reflect others' likes
            refetchIntervalInBackground: true, // Continue polling even when tab is not active
        },
    );

    // Get user's reaction status for all posts
    const userReactionsQuery = trpc.community.getUserReactions.useQuery(
        { postIds },
        {
            enabled: postIds.length > 0 && !!session,
            staleTime: 0, // Always fetch fresh data
            refetchOnWindowFocus: true,
            refetchInterval: 5 * 1000, // More frequent polling to reflect others' likes
            refetchIntervalInBackground: true, // Continue polling even when tab is not active
        },
    );

    // Update posts with like data when like queries change
    useEffect(() => {
        if (likeCountsQuery.data || userReactionsQuery.data) {
            setPostsWithLikes(
                filteredPosts.map((post) => ({
                    ...post,
                    likeCount: likeCountsQuery.data?.[post.id] ?? 0,
                    isLiked: userReactionsQuery.data?.[post.id] ?? false,
                })),
            );
        } else {
            setPostsWithLikes(filteredPosts);
        }
    }, [filteredPosts, likeCountsQuery.data, userReactionsQuery.data]);

    // Memoize refetch functions to prevent dependency array changes
    const refetchLikeCounts = useCallback(() => {
        utils.community.getPostLikeCounts.refetch();
    }, [utils.community.getPostLikeCounts]);

    const refetchUserReactions = useCallback(() => {
        utils.community.getUserReactions.refetch();
    }, [utils.community.getUserReactions]);

    // Refetch like data when filtered posts change
    useEffect(() => {
        if (filteredPosts.length > 0) {
            refetchLikeCounts();
            if (session) {
                refetchUserReactions();
            }
        }
    }, [
        filteredPosts.length,
        session,
        refetchLikeCounts,
        refetchUserReactions,
    ]);
    // Check if we're still loading like data
    const isLikeDataLoading =
        postsWithLikes.length > 0 && !likeCountsQuery.data;

    return (
        <TabsContent value="posts" className="mt-0 space-y-6">
            {/* Show loading skeleton while data is being fetched */}
            {isLoading || isLikeDataLoading ? (
                <div className="space-y-4">
                    {[...Array(3)].map((_, index) => (
                        <Card key={index} className="relative gap-2 py-2">
                            <div className="px-4 py-0">
                                <Skeleton className="mb-2 h-6 w-3/4" />
                                <Skeleton className="mb-2 h-4 w-full" />
                                <Skeleton className="mb-2 h-4 w-full" />
                                <Skeleton className="mb-2 h-4 w-2/3" />
                                <div className="mt-3 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Skeleton className="h-4 w-32" />
                                        <div className="ml-4">
                                            <Skeleton className="h-4 w-8" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </Card>
                    ))}
                </div>
            ) : (
                <>
                    {/* Post creation restriction message - only show when there are actual restrictions */}
                    {(() => {
                        const currentRequirement =
                            community.postCreationMinRole || 'member';

                        // Only show the message if there are actual restrictions (not for 'member')
                        if (currentRequirement === 'member') {
                            return null;
                        }

                        const roleDisplay = {
                            moderator: 'Moderators and admins',
                            admin: 'Admins only',
                        };

                        return (
                            <div className="mb-4">
                                <p className="text-muted-foreground">
                                    Post creation is restricted to:{' '}
                                    <span className="font-medium">
                                        {
                                            roleDisplay[
                                                currentRequirement as keyof typeof roleDisplay
                                            ]
                                        }
                                    </span>
                                </p>
                            </div>
                        );
                    })()}

                    {/* Posts header and tag filters */}
                    <div className="mb-6 flex items-center justify-between">
                        <div className="flex flex-col">
                            <h2 className="text-xl font-semibold">Posts</h2>
                            <p className="text-muted-foreground text-sm">
                                All the posts in this community
                            </p>
                        </div>
                        {canCreatePost && (
                            <Button asChild>
                                <Link
                                    href={`/posts/new?communityId=${community.id}&communitySlug=${community.slug}`}
                                >
                                    Create Post
                                </Link>
                            </Button>
                        )}
                    </div>

                    {/* Post Filter */}
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <button
                                onClick={onPostFilterToggle}
                                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                                    !showMyPosts
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                                }`}
                            >
                                <Building className="h-4 w-4" />
                                All Posts
                            </button>
                            <button
                                onClick={onPostFilterToggle}
                                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                                    showMyPosts
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                                }`}
                            >
                                <Users className="h-4 w-4" />
                                My Posts
                            </button>
                        </div>
                        <DateFilter
                            value={dateFilter}
                            onChange={onDateFilterChange}
                        />
                    </div>
                    {/* Tag Filter */}
                    {community.tags && community.tags.length > 0 && (
                        <div className="mt-4 mb-6">
                            <div className="flex flex-wrap gap-2">
                                {community.tags.map((tag: any) => (
                                    <button
                                        key={tag.id}
                                        onClick={() =>
                                            onTagFilterToggle(tag.id)
                                        }
                                        className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                                            selectedTagFilters.includes(tag.id)
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                                        }`}
                                    >
                                        {tag.name}
                                    </button>
                                ))}
                                {selectedTagFilters.length > 0 && (
                                    <button
                                        onClick={onClearTagFilters}
                                        className="bg-muted text-muted-foreground hover:bg-muted/80 inline-flex items-center rounded-full px-3 py-1 text-sm font-medium"
                                    >
                                        Clear Filters
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Render posts for members */}
                    {isMember &&
                        postsWithLikes &&
                        postsWithLikes.length > 0 && (
                            <div className="space-y-4">
                                {postsWithLikes.map((post: any) => (
                                    <Link
                                        key={post.id}
                                        href={`/communities/${community.slug}/posts/${post.id}`}
                                        className="block"
                                        style={{
                                            textDecoration: 'none',
                                        }}
                                    >
                                        <Card className="relative gap-2 py-2 transition-shadow hover:shadow-md">
                                            {/* Post content */}
                                            <div className="px-4 py-0">
                                                {/* Post title */}
                                                <h3 className="mt-0 mb-2 text-base font-medium">
                                                    {post.isDeleted
                                                        ? '[Deleted]'
                                                        : post.title}
                                                </h3>

                                                {/* Post content */}
                                                {post.isDeleted ? (
                                                    <div className="space-y-1">
                                                        <span className="text-muted-foreground text-sm italic">
                                                            [Content deleted]
                                                        </span>
                                                        <span className="text-muted-foreground block text-xs">
                                                            Removed on{' '}
                                                            {new Date(
                                                                post.updatedAt,
                                                            ).toLocaleString()}
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <div className="text-muted-foreground text-sm">
                                                        <SafeHtml
                                                            html={post.content}
                                                            className="line-clamp-2 overflow-hidden leading-5 text-ellipsis"
                                                        />
                                                    </div>
                                                )}

                                                {/* Tags display */}
                                                {post.tags &&
                                                    post.tags.length > 0 && (
                                                        <div className="mt-2 flex flex-wrap gap-1">
                                                            {post.tags
                                                                .slice(0, 3)
                                                                .map(
                                                                    (
                                                                        tag: any,
                                                                    ) => (
                                                                        <span
                                                                            key={
                                                                                tag.id
                                                                            }
                                                                            className="bg-secondary inline-flex items-center rounded-full px-2 py-1 text-xs font-medium"
                                                                            style={{
                                                                                backgroundColor:
                                                                                    tag.color
                                                                                        ? `${tag.color}20`
                                                                                        : undefined,
                                                                                color:
                                                                                    tag.color ||
                                                                                    undefined,
                                                                            }}
                                                                        >
                                                                            {
                                                                                tag.name
                                                                            }
                                                                        </span>
                                                                    ),
                                                                )}
                                                            {post.tags.length >
                                                                3 && (
                                                                <span className="bg-secondary text-muted-foreground inline-flex items-center rounded-full px-2 py-1 text-xs font-medium">
                                                                    +
                                                                    {post.tags
                                                                        .length -
                                                                        3}{' '}
                                                                    more
                                                                </span>
                                                            )}
                                                        </div>
                                                    )}

                                                {/* Post metadata */}
                                                <div className="mt-3 flex items-center justify-between">
                                                    <div className="flex items-center">
                                                        <span className="text-muted-foreground text-xs">
                                                            Posted by{' '}
                                                            {post.author?.id ? (
                                                                <UserProfilePopover
                                                                    userId={
                                                                        post
                                                                            .author
                                                                            .id
                                                                    }
                                                                >
                                                                    <span className="cursor-pointer hover:underline">
                                                                        {post
                                                                            .author
                                                                            ?.name ||
                                                                            'Unknown'}
                                                                    </span>
                                                                </UserProfilePopover>
                                                            ) : (
                                                                'Unknown'
                                                            )}{' '}
                                                            •{' '}
                                                            {new Date(
                                                                post.createdAt,
                                                            ).toLocaleDateString()}
                                                        </span>
                                                        <div className="ml-4 flex flex-row items-center space-x-2">
                                                            {/* Like button - visible for everyone; disabled if not logged in */}
                                                            <div
                                                                onClick={(
                                                                    e,
                                                                ) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                }}
                                                            >
                                                                <LikeButton
                                                                    postId={
                                                                        post.id
                                                                    }
                                                                    initialLikeCount={
                                                                        post.likeCount ||
                                                                        0
                                                                    }
                                                                    initialIsLiked={
                                                                        post.isLiked ||
                                                                        false
                                                                    }
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    disabled={
                                                                        !session
                                                                    }
                                                                />
                                                            </div>
                                                            <button
                                                                className="text-muted-foreground flex items-center text-xs"
                                                                onClick={(
                                                                    e,
                                                                ) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    router.push(
                                                                        `/communities/${community.slug}/posts/${post.id}`,
                                                                    );
                                                                }}
                                                            >
                                                                <MessageSquare className="mr-1 h-3 w-3" />
                                                                {Array.isArray(
                                                                    post.comments,
                                                                )
                                                                    ? post
                                                                          .comments
                                                                          .length
                                                                    : 0}
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {/* Action buttons */}
                                                    <div className="flex items-center space-x-1">
                                                        <div
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                            }}
                                                        >
                                                            <ShareButton
                                                                title={
                                                                    post.title
                                                                }
                                                                text={`Check out this post: ${post.title}`}
                                                                url={`${typeof window !== 'undefined' ? window.location.origin : ''}/communities/${community.slug}/posts/${post.id}`}
                                                                variant="ghost"
                                                                size="sm"
                                                                className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-full p-1.5"
                                                            />
                                                        </div>
                                                        {canEditPost(post) && (
                                                            <button
                                                                type="button"
                                                                onClick={(
                                                                    e: React.MouseEvent,
                                                                ) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    router.push(
                                                                        `/communities/${community.slug}/posts/${post.id}/edit`,
                                                                    );
                                                                }}
                                                                className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-full p-1.5"
                                                            >
                                                                <Edit className="h-4 w-4" />
                                                            </button>
                                                        )}
                                                        {canDeletePost(
                                                            post,
                                                        ) && (
                                                            <button
                                                                type="button"
                                                                onClick={(e) =>
                                                                    onDeletePost(
                                                                        post.id,
                                                                        e,
                                                                    )
                                                                }
                                                                className="text-muted-foreground hover:bg-accent hover:text-destructive rounded-full p-1.5"
                                                            >
                                                                <Trash2 className="h-4 w-4" />
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </Card>
                                    </Link>
                                ))}
                            </div>
                        )}

                    {/* Empty state for members */}
                    {isMember &&
                        (!postsWithLikes || postsWithLikes.length === 0) && (
                            <div className="py-12 text-center">
                                <Building className="text-muted-foreground mx-auto mb-4 h-12 w-12 opacity-50" />
                                <p className="text-muted-foreground">
                                    {selectedTagFilters.length > 0
                                        ? 'No posts match the selected tags.'
                                        : showMyPosts
                                          ? "You haven't created any posts in this community yet."
                                          : 'No posts yet.'}
                                </p>
                                {selectedTagFilters.length > 0 ? (
                                    <Button
                                        onClick={onClearTagFilters}
                                        className="mt-4"
                                    >
                                        Clear Filters
                                    </Button>
                                ) : showMyPosts ? (
                                    <Button
                                        onClick={onClearPostFilter}
                                        className="mt-4"
                                    >
                                        Show All Posts
                                    </Button>
                                ) : canCreatePost ? (
                                    <Button asChild className="mt-4">
                                        <Link
                                            href={`/posts/new?communityId=${community.id}&communitySlug=${community.slug}`}
                                        >
                                            <Plus className="mr-2 h-4 w-4" />
                                            Create First Post
                                        </Link>
                                    </Button>
                                ) : null}
                            </div>
                        )}
                </>
            )}
        </TabsContent>
    );
}
