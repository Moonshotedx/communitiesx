'use client';

import { useState } from 'react';
import { ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/providers/trpc-provider';
import { cn } from '@/lib/utils';

interface LikeButtonProps {
    postId: number;
    initialLikeCount: number;
    initialIsLiked: boolean;
    className?: string;
    size?: 'sm' | 'md' | 'lg';
    variant?: 'default' | 'ghost' | 'outline';
    disabled?: boolean;
}

export function LikeButton({
    postId,
    initialLikeCount,
    initialIsLiked,
    className,
    size = 'sm',
    variant = 'ghost',
    disabled = false,
}: LikeButtonProps) {
    const [isLiked, setIsLiked] = useState(initialIsLiked);
    const [likeCount, setLikeCount] = useState(initialLikeCount);
    const [isLoading, setIsLoading] = useState(false);

    const utils = trpc.useUtils();

    const likeMutation = trpc.community.likePost.useMutation({
        onMutate: () => {
            // Optimistic update
            setIsLiked(true);
            setLikeCount((prev) => prev + 1);
            setIsLoading(true);
        },
        onSuccess: (data) => {
            setLikeCount(data.likeCount);
            setIsLoading(false);
            // Refresh counts cache for this post
            utils.community.getPostLikeCounts.invalidate({ postIds: [postId] });
        },
        onError: () => {
            // Revert optimistic update on error
            setIsLiked(false);
            setLikeCount((prev) => prev - 1);
            setIsLoading(false);
        },
    });

    const unlikeMutation = trpc.community.unlikePost.useMutation({
        onMutate: () => {
            // Optimistic update
            setIsLiked(false);
            setLikeCount((prev) => Math.max(0, prev - 1));
            setIsLoading(true);
        },
        onSuccess: (data) => {
            setLikeCount(data.likeCount);
            setIsLoading(false);
            // Refresh counts cache for this post
            utils.community.getPostLikeCounts.invalidate({ postIds: [postId] });
        },
        onError: () => {
            // Revert optimistic update on error
            setIsLiked(true);
            setLikeCount((prev) => prev + 1);
            setIsLoading(false);
        },
    });

    const handleLike = () => {
        if (isLoading || disabled) return;

        if (isLiked) {
            unlikeMutation.mutate({ postId });
        } else {
            likeMutation.mutate({ postId });
        }
    };

    const sizeClasses = {
        sm: 'h-8 w-8 p-1',
        md: 'h-9 w-9 p-1.5',
        lg: 'h-10 w-10 p-2',
    };

    const iconSizes = {
        sm: 'h-3 w-3',
        md: 'h-4 w-4',
        lg: 'h-5 w-5',
    };

    return (
        <div className="flex items-center gap-1">
            <Button
                variant={variant}
                size="sm"
                onClick={handleLike}
                disabled={isLoading || disabled}
                className={cn(
                    sizeClasses[size],
                    'text-muted-foreground hover:bg-accent hover:text-foreground rounded-full p-1.5 transition-colors',
                    isLiked && 'text-red-500 hover:text-red-600',
                    className,
                )}
            >
                <ThumbsUp
                    className={cn(
                        iconSizes[size],
                        'transition-all duration-200',
                        isLiked && 'fill-current',
                    )}
                />
            </Button>
            {likeCount > 0 && (
                <span className="text-muted-foreground text-xs font-medium">
                    {likeCount}
                </span>
            )}
        </div>
    );
}
