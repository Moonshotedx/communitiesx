'use client';

import { useState, useEffect } from 'react';
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

    // Update state when props change (e.g., on refresh)
    useEffect(() => {
        setIsLiked(initialIsLiked);
        setLikeCount(initialLikeCount);
    }, [initialIsLiked, initialLikeCount]);

    const utils = trpc.useUtils();

    const likeMutation = trpc.community.likePost.useMutation({
        onMutate: () => {
            // Optimistic update
            const previousState = { isLiked, likeCount };
            setIsLiked(true);
            setLikeCount((prev) => prev + 1);
            return { previousState };
        },
        onSuccess: (data) => {
            setLikeCount(data.likeCount);
            // Refresh counts cache for all posts
            utils.community.getPostLikeCounts.invalidate();
        },
        onError: (error, variables, context) => {
            // Revert optimistic update on error
            if (context?.previousState) {
                setIsLiked(context.previousState.isLiked);
                setLikeCount(context.previousState.likeCount);
            }
        },
    });

    const unlikeMutation = trpc.community.unlikePost.useMutation({
        onMutate: () => {
            // Optimistic update
            setIsLiked(false);
            setLikeCount((prev) => Math.max(0, prev - 1));
        },
        onSuccess: (data) => {
            setLikeCount(data.likeCount);
            // Refresh counts cache for all posts
            utils.community.getPostLikeCounts.invalidate();
        },
        onError: () => {
            // Revert optimistic update on error
            setIsLiked(true);
            setLikeCount((prev) => prev + 1);
        },
    });

    const isLoading = likeMutation.isPending || unlikeMutation.isPending;

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
        <div className="flex items-center">
            <Button
                variant={variant}
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
