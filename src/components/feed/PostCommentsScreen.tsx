import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { collection, onSnapshot } from 'firebase/firestore';
import { SafeAreaView, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { font, hairline, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import UserAvatar from '../UserAvatar';
import type { ProductLike } from '../ProductModal';
import FeedPostCard from './FeedPostCard';
import { useRightSwipeDismiss } from '../../hooks/useRightSwipeDismiss';
import {
  createCommentReply,
  createPostComment,
  deleteCommentReply,
  deletePostComment,
  subscribeCommentReplies,
  subscribePostComments,
  type PostCommentRecord,
  type PostReplyRecord,
} from '../../lib/postComments';
import {
  makeCommentLikeKey,
  makeReplyLikeKey,
  setCommentLike,
  setReplyLike,
  subscribeUserCommentLikeKeys,
  subscribeUserReplyLikeKeys,
} from '../../lib/commentLikes';
import {
  createEmptyCommentRankCache,
  loadCommentRankCache,
  rankComments,
  rankReplies,
  registerCommentImpressions,
  registerCommentLike,
  saveCommentRankCache,
  type CommentRankCache,
} from '../../lib/commentRanking';
import { db } from '../../lib/firebase';
import { blockUser, reportComment, reportPost, reportReply, reportUser, unblockUser } from '../../lib/postModeration';
import { formatCompactCount } from '../../lib/formatCounts';

type KnownUser = {
  id: string;
  username: string;
  avatarUri?: string | null;
  bio?: string;
};

export type CommentScreenPostPreview = {
  id: string;
  user: {
    id: string;
    username: string;
    avatarUri?: string | null;
    bio?: string;
  };
  modelUri: string;
  caption?: string | null;
  likes?: number;
  commentCount?: number;
  garments: ProductLike[];
};

type Props = {
  visible: boolean;
  post?: CommentScreenPostPreview | null;
  viewerUid?: string | null;
  viewerUsername?: string | null;
  viewerPhotoURL?: string | null;
  viewerLikedPost?: boolean;
  followingIds?: string[];
  knownUsers?: Record<string, KnownUser>;
  onOpenUser?: (user: KnownUser) => void;
  onToggleFollowUser?: (userId: string) => void;
  onOpenProduct?: (product: ProductLike) => void;
  onCountChange?: (count: number) => void;
  onClose: () => void;
};

type ReplyTarget = {
  commentId: string;
  username: string;
};

const MAX_COMMENT_LENGTH = 800;

const formatRelativeTime = (ts: number) => {
  const delta = Math.max(1, Date.now() - ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
};

const fallbackUser = (uid: string, username?: string | null, avatarUri?: string | null): KnownUser => ({
  id: uid,
  username: username || 'user',
  avatarUri: avatarUri || '',
});

export default function PostCommentsScreen({
  visible,
  post,
  viewerUid,
  viewerUsername,
  viewerPhotoURL,
  viewerLikedPost = false,
  followingIds,
  knownUsers,
  onOpenUser,
  onToggleFollowUser,
  onOpenProduct,
  onCountChange,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const safeTopInset = Math.max(
    insets.top,
    initialWindowMetrics?.insets.top ?? 0,
    Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0
  );
  const safeBottomInset = Math.max(insets.bottom, initialWindowMetrics?.insets.bottom ?? 0);
  const { colors, isDark } = useTheme();
  const primaryActionBg = isDark ? '#fff' : colors.text;
  const primaryActionFg = isDark ? colors.bg : '#fff';

  const [comments, setComments] = useState<PostCommentRecord[]>([]);
  const [repliesByComment, setRepliesByComment] = useState<Record<string, PostReplyRecord[]>>({});
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [commentsHydrated, setCommentsHydrated] = useState(false);
  const [sending, setSending] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [likedCommentKeys, setLikedCommentKeys] = useState<Set<string>>(new Set());
  const [likedReplyKeys, setLikedReplyKeys] = useState<Set<string>>(new Set());
  const [livePostLikeCount, setLivePostLikeCount] = useState<number | null>(null);
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const [moderationBusy, setModerationBusy] = useState(false);
  const [rankCache, setRankCache] = useState<CommentRankCache>(createEmptyCommentRankCache());
  const [rankCacheReady, setRankCacheReady] = useState(false);

  const remainingChars = Math.max(0, MAX_COMMENT_LENGTH - draft.length);
  const canModeratePost = Boolean(viewerUid && post?.user?.id && viewerUid === post.user.id);
  const followingSet = useMemo(() => new Set(followingIds || []), [followingIds]);
  const canFollowPostAuthor = Boolean(
    viewerUid &&
      post?.user?.id &&
      viewerUid !== post.user.id &&
      onToggleFollowUser
  );
  const isFollowingPostAuthor = Boolean(post?.user?.id && followingSet.has(post.user.id));

  const {
    translateX,
    opacity,
    bgOpacity,
    panHandlers,
    isDraggingRef,
    closeWithSwipe,
  } = useRightSwipeDismiss({
    visible,
    onDismiss: onClose,
  });

  const resolveUser = useCallback(
    (uid: string, username?: string | null, avatarUri?: string | null): KnownUser => {
      return knownUsers?.[uid] || fallbackUser(uid, username, avatarUri);
    },
    [knownUsers]
  );

  const canDeleteComment = useCallback(
    (comment: PostCommentRecord) => {
      if (!viewerUid) return false;
      return viewerUid === comment.authorUid || canModeratePost;
    },
    [canModeratePost, viewerUid]
  );

  const canDeleteReply = useCallback(
    (reply: PostReplyRecord) => {
      if (!viewerUid) return false;
      return viewerUid === reply.authorUid || canModeratePost;
    },
    [canModeratePost, viewerUid]
  );

  useEffect(() => {
    if (!visible) {
      setDraft('');
      setComments([]);
      setRepliesByComment({});
      setReplyTarget(null);
      setExpandedReplies(new Set());
      setLoading(false);
      setCommentsHydrated(false);
      setSending(false);
      setDeletingKey(null);
      setLikedCommentKeys(new Set());
      setLikedReplyKeys(new Set());
      setLivePostLikeCount(null);
      setBlockedIds(new Set());
      setModerationBusy(false);
      setRankCache(createEmptyCommentRankCache());
      setRankCacheReady(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !post?.id || !viewerUid) {
      setComments([]);
      setRepliesByComment({});
      setLoading(false);
      setCommentsHydrated(false);
      return;
    }
    setLoading(true);
    setCommentsHydrated(false);
    const unsub = subscribePostComments(
      post.id,
      (items) => {
        setLoading(false);
        setCommentsHydrated(true);
        setComments(items);
      },
      (error) => {
        setLoading(false);
        setCommentsHydrated(true);
        if (error?.code === 'permission-denied') {
          setComments([]);
          return;
        }
        console.warn('[PostCommentsScreen] comments subscription failed', error);
      }
    );
    return () => unsub();
  }, [post?.id, viewerUid, visible]);

  useEffect(() => {
    if (!visible || !post?.id || !viewerUid || !comments.length) {
      setRepliesByComment({});
      return;
    }
    const unsubs: Array<() => void> = [];
    comments.forEach((comment) => {
      const unsub = subscribeCommentReplies(
        post.id,
        comment.id,
        (items) => {
          setRepliesByComment((prev) => ({ ...prev, [comment.id]: items }));
        },
        (error) => {
          if (error?.code === 'permission-denied') {
            setRepliesByComment((prev) => ({ ...prev, [comment.id]: [] }));
            return;
          }
          console.warn('[PostCommentsScreen] replies subscription failed', error);
        }
      );
      unsubs.push(unsub);
    });

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [comments, post?.id, viewerUid, visible]);

  useEffect(() => {
    let cancelled = false;
    if (!visible || !viewerUid) {
      setRankCache(createEmptyCommentRankCache());
      setRankCacheReady(false);
      return;
    }
    void loadCommentRankCache(viewerUid).then((cache) => {
      if (cancelled) return;
      setRankCache(cache);
      setRankCacheReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [viewerUid, visible]);

  useEffect(() => {
    if (!visible || !viewerUid) {
      setLikedCommentKeys(new Set());
      setLikedReplyKeys(new Set());
      return;
    }
    const unsubComments = subscribeUserCommentLikeKeys(viewerUid, setLikedCommentKeys);
    const unsubReplies = subscribeUserReplyLikeKeys(viewerUid, setLikedReplyKeys);
    return () => {
      unsubComments();
      unsubReplies();
    };
  }, [viewerUid, visible]);

  useEffect(() => {
    if (!visible || !viewerUid || !post?.id) {
      setLivePostLikeCount(null);
      return;
    }
    const likersRef = collection(db, 'posts', post.id, 'likers');
    const unsub = onSnapshot(
      likersRef,
      (snap) => setLivePostLikeCount(snap.size),
      (error) => {
        if (error?.code === 'permission-denied') {
          setLivePostLikeCount(null);
          return;
        }
        console.warn('[PostCommentsScreen] post likers subscription failed', error);
      }
    );
    return () => unsub();
  }, [post?.id, viewerUid, visible]);

  useEffect(() => {
    if (!visible || !viewerUid) {
      setBlockedIds(new Set());
      return;
    }
    const blockedRef = collection(db, 'users', viewerUid, 'blocked');
    const unsub = onSnapshot(
      blockedRef,
      (snap) => setBlockedIds(new Set(snap.docs.map((d) => d.id))),
      (error) => {
        if (error?.code === 'permission-denied') {
          setBlockedIds(new Set());
          return;
        }
        console.warn('[PostCommentsScreen] blocked subscription failed', error);
      }
    );
    return () => unsub();
  }, [viewerUid, visible]);

  useEffect(() => {
    if (!viewerUid || !rankCacheReady || !visible) return;
    void saveCommentRankCache(viewerUid, rankCache);
  }, [rankCache, rankCacheReady, viewerUid, visible]);

  const totalComments = useMemo(() => {
    if (commentsHydrated) return comments.length;
    return Math.max(0, Number(post?.commentCount ?? comments.length) || 0);
  }, [comments.length, commentsHydrated, post?.commentCount]);

  const rankedComments = useMemo(() => {
    if (!post?.id || !comments.length) return comments;
    return rankComments({
      postId: post.id,
      comments,
      followingIds: followingSet,
      likedCommentKeys,
      cache: rankCache,
    });
  }, [comments, followingSet, likedCommentKeys, post?.id, rankCache]);

  const rankedRepliesByComment = useMemo(() => {
    if (!post?.id) return repliesByComment;
    const next: Record<string, PostReplyRecord[]> = {};
    Object.entries(repliesByComment).forEach(([commentId, replies]) => {
      next[commentId] = rankReplies({
        postId: post.id,
        commentId,
        replies,
        followingIds: followingSet,
        likedReplyKeys,
        cache: rankCache,
      });
    });
    return next;
  }, [followingSet, likedReplyKeys, post?.id, rankCache, repliesByComment]);

  useEffect(() => {
    if (!commentsHydrated) return;
    onCountChange?.(comments.length);
  }, [comments.length, commentsHydrated, onCountChange]);

  useEffect(() => {
    if (!post?.id || !rankCacheReady || !viewerUid) return;
    const impressions: Array<{ kind: 'comment' | 'reply'; key: string; authorId: string }> = [];
    rankedComments.forEach((comment) => {
      impressions.push({
        kind: 'comment',
        key: makeCommentLikeKey(post.id, comment.id),
        authorId: comment.authorUid,
      });
    });
    Object.entries(rankedRepliesByComment).forEach(([commentId, replies]) => {
      replies.forEach((reply) => {
        impressions.push({
          kind: 'reply',
          key: makeReplyLikeKey(post.id, commentId, reply.id),
          authorId: reply.authorUid,
        });
      });
    });
    if (!impressions.length) return;
    setRankCache((prev) => registerCommentImpressions(prev, impressions));
  }, [post?.id, rankCacheReady, rankedComments, rankedRepliesByComment, viewerUid]);

  const toggleCommentLike = useCallback(
    async (comment: PostCommentRecord) => {
      if (!viewerUid || !post?.id) return;
      const key = makeCommentLikeKey(post.id, comment.id);
      const nextLiked = !likedCommentKeys.has(key);
      const delta = nextLiked ? 1 : -1;
      setLikedCommentKeys((prev) => {
        const next = new Set(prev);
        if (nextLiked) next.add(key);
        else next.delete(key);
        return next;
      });
      setComments((prev) =>
        prev.map((item) =>
          item.id === comment.id ? { ...item, likeCount: Math.max(0, (item.likeCount || 0) + delta) } : item
        )
      );
      setRankCache((prev) =>
        registerCommentLike(prev, {
          kind: 'comment',
          key,
          authorId: comment.authorUid,
          liked: nextLiked,
        })
      );
      try {
        await setCommentLike({
          uid: viewerUid,
          postId: post.id,
          commentId: comment.id,
          liked: nextLiked,
        });
      } catch (error) {
        setLikedCommentKeys((prev) => {
          const next = new Set(prev);
          if (nextLiked) next.delete(key);
          else next.add(key);
          return next;
        });
        setComments((prev) =>
          prev.map((item) =>
            item.id === comment.id ? { ...item, likeCount: Math.max(0, (item.likeCount || 0) - delta) } : item
          )
        );
        setRankCache((prev) =>
          registerCommentLike(prev, {
            kind: 'comment',
            key,
            authorId: comment.authorUid,
            liked: !nextLiked,
          })
        );
        console.warn('[PostCommentsScreen] comment like toggle failed', error);
      }
    },
    [likedCommentKeys, post?.id, viewerUid]
  );

  const toggleReplyLike = useCallback(
    async (commentId: string, reply: PostReplyRecord) => {
      if (!viewerUid || !post?.id) return;
      const key = makeReplyLikeKey(post.id, commentId, reply.id);
      const nextLiked = !likedReplyKeys.has(key);
      const delta = nextLiked ? 1 : -1;

      setLikedReplyKeys((prev) => {
        const next = new Set(prev);
        if (nextLiked) next.add(key);
        else next.delete(key);
        return next;
      });
      setRepliesByComment((prev) => ({
        ...prev,
        [commentId]: (prev[commentId] || []).map((item) =>
          item.id === reply.id ? { ...item, likeCount: Math.max(0, (item.likeCount || 0) + delta) } : item
        ),
      }));
      setRankCache((prev) =>
        registerCommentLike(prev, {
          kind: 'reply',
          key,
          authorId: reply.authorUid,
          liked: nextLiked,
        })
      );
      try {
        await setReplyLike({
          uid: viewerUid,
          postId: post.id,
          commentId,
          replyId: reply.id,
          liked: nextLiked,
        });
      } catch (error) {
        setLikedReplyKeys((prev) => {
          const next = new Set(prev);
          if (nextLiked) next.delete(key);
          else next.add(key);
          return next;
        });
        setRepliesByComment((prev) => ({
          ...prev,
          [commentId]: (prev[commentId] || []).map((item) =>
            item.id === reply.id ? { ...item, likeCount: Math.max(0, (item.likeCount || 0) - delta) } : item
          ),
        }));
        setRankCache((prev) =>
          registerCommentLike(prev, {
            kind: 'reply',
            key,
            authorId: reply.authorUid,
            liked: !nextLiked,
          })
        );
        console.warn('[PostCommentsScreen] reply like toggle failed', error);
      }
    },
    [likedReplyKeys, post?.id, viewerUid]
  );

  const toggleReplies = useCallback((commentId: string) => {
    setExpandedReplies((prev) => {
      const next = new Set(prev);
      if (next.has(commentId)) {
        next.delete(commentId);
      } else {
        next.add(commentId);
      }
      return next;
    });
  }, []);

  const handleReplyPress = useCallback((commentId: string, username: string) => {
    setReplyTarget({ commentId, username });
    setExpandedReplies((prev) => {
      const next = new Set(prev);
      next.add(commentId);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!viewerUid || !post?.id || sending) return;
    const rawText = draft.trim();
    if (!rawText) return;

    const text =
      replyTarget && !rawText.startsWith(`@${replyTarget.username}`)
        ? `@${replyTarget.username} ${rawText}`
        : rawText;

    setSending(true);
    try {
      if (replyTarget) {
        await createCommentReply({
          postId: post.id,
          commentId: replyTarget.commentId,
          authorUid: viewerUid,
          authorUsername: viewerUsername,
          authorPhotoURL: viewerPhotoURL,
          text,
        });
      } else {
        await createPostComment({
          postId: post.id,
          authorUid: viewerUid,
          authorUsername: viewerUsername,
          authorPhotoURL: viewerPhotoURL,
          text,
        });
      }
      setDraft('');
      setReplyTarget(null);
    } catch (error) {
      console.warn('[PostCommentsScreen] submit failed', error);
    } finally {
      setSending(false);
    }
  }, [draft, post?.id, replyTarget, sending, viewerPhotoURL, viewerUid, viewerUsername]);

  const handleDeleteComment = useCallback(
    async (comment: PostCommentRecord) => {
      if (!post?.id || !canDeleteComment(comment)) return;
      const key = `comment:${comment.id}`;
      try {
        setDeletingKey(key);
        await deletePostComment({ postId: post.id, commentId: comment.id });
        setReplyTarget((prev) => (prev?.commentId === comment.id ? null : prev));
      } catch (error) {
        console.warn('[PostCommentsScreen] delete comment failed', error);
      } finally {
        setDeletingKey(null);
      }
    },
    [canDeleteComment, post?.id]
  );

  const handleDeleteReply = useCallback(
    async (commentId: string, reply: PostReplyRecord) => {
      if (!post?.id || !canDeleteReply(reply)) return;
      const key = `reply:${commentId}:${reply.id}`;
      try {
        setDeletingKey(key);
        await deleteCommentReply({ postId: post.id, commentId, replyId: reply.id });
      } catch (error) {
        console.warn('[PostCommentsScreen] delete reply failed', error);
      } finally {
        setDeletingKey(null);
      }
    },
    [canDeleteReply, post?.id]
  );

  const toggleBlockUser = useCallback(
    async (targetUid: string, nextBlock: boolean) => {
      if (!viewerUid || !targetUid || targetUid === viewerUid) return;
      setModerationBusy(true);
      setBlockedIds((prev) => {
        const next = new Set(prev);
        if (nextBlock) next.add(targetUid);
        else next.delete(targetUid);
        return next;
      });
      try {
        if (nextBlock) {
          await blockUser({
            viewerUid,
            targetUid,
            reason: 'blocked from comments',
          });
        } else {
          await unblockUser({
            viewerUid,
            targetUid,
          });
        }
      } catch (error: any) {
        setBlockedIds((prev) => {
          const next = new Set(prev);
          if (nextBlock) next.delete(targetUid);
          else next.add(targetUid);
          return next;
        });
        Alert.alert('Action failed', error?.message || 'Unable to update block state.');
      } finally {
        setModerationBusy(false);
      }
    },
    [viewerUid]
  );

  const openPostOptions = useCallback(() => {
    if (!post || !viewerUid) {
      Alert.alert('Sign in required', 'Please sign in to use moderation tools.');
      return;
    }
    const targetUid = post.user.id;
    const isOwn = targetUid === viewerUid;
    const isBlocked = blockedIds.has(targetUid);

    const actions: Array<{ text: string; style?: 'default' | 'destructive' | 'cancel'; onPress?: () => void }> = [
      { text: 'Cancel', style: 'cancel' },
    ];

    if (!isOwn) {
      actions.unshift(
        {
          text: 'Report post',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Report post', 'Select a reason', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Spam',
                onPress: async () => {
                  setModerationBusy(true);
                  try {
                    await reportPost({ reporterUid: viewerUid, postId: post.id, reasonCode: 'spam' });
                    Alert.alert('Reported', 'Post reported.');
                  } catch (error: any) {
                    Alert.alert('Report failed', error?.message || 'Unable to submit report.');
                  } finally {
                    setModerationBusy(false);
                  }
                },
              },
              {
                text: 'Inappropriate',
                onPress: async () => {
                  setModerationBusy(true);
                  try {
                    await reportPost({ reporterUid: viewerUid, postId: post.id, reasonCode: 'inappropriate' });
                    Alert.alert('Reported', 'Post reported.');
                  } catch (error: any) {
                    Alert.alert('Report failed', error?.message || 'Unable to submit report.');
                  } finally {
                    setModerationBusy(false);
                  }
                },
              },
            ]);
          },
        },
        {
          text: 'Report user',
          style: 'destructive',
          onPress: async () => {
            setModerationBusy(true);
            try {
              await reportUser({
                reporterUid: viewerUid,
                targetUid,
                reasonCode: 'harassment',
                note: `fromPost=${post.id}`,
              });
              Alert.alert('Reported', 'User reported.');
            } catch (error: any) {
              Alert.alert('Report failed', error?.message || 'Unable to submit report.');
            } finally {
              setModerationBusy(false);
            }
          },
        },
        {
          text: isBlocked ? 'Unblock user' : 'Block user',
          style: isBlocked ? 'default' : 'destructive',
          onPress: () => void toggleBlockUser(targetUid, !isBlocked),
        }
      );
    }

    Alert.alert('Post options', undefined, actions);
  }, [blockedIds, post, toggleBlockUser, viewerUid]);

  const openCommentOptions = useCallback(
    (comment: PostCommentRecord) => {
      if (!viewerUid || !post?.id) {
        Alert.alert('Sign in required', 'Please sign in to use moderation tools.');
        return;
      }
      const commentUser = resolveUser(comment.authorUid, comment.authorUsername, comment.authorPhotoURL);
      const isOwnComment = viewerUid === comment.authorUid;
      const isBlocked = blockedIds.has(comment.authorUid);
      const actions: Array<{ text: string; style?: 'default' | 'destructive' | 'cancel'; onPress?: () => void }> = [
        { text: 'Cancel', style: 'cancel' },
      ];

      if (canDeleteComment(comment)) {
        actions.unshift({
          text: 'Delete comment',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Delete comment?', 'This cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  void handleDeleteComment(comment);
                },
              },
            ]);
          },
        });
      }

      if (!isOwnComment) {
        actions.unshift(
          {
            text: 'Report comment',
            style: 'destructive',
            onPress: async () => {
              setModerationBusy(true);
              try {
                await reportComment({
                  reporterUid: viewerUid,
                  postId: post.id,
                  commentId: comment.id,
                  reasonCode: 'abusive_comment',
                });
                Alert.alert('Reported', 'Comment reported.');
              } catch (error: any) {
                Alert.alert('Report failed', error?.message || 'Unable to submit report.');
              } finally {
                setModerationBusy(false);
              }
            },
          },
          {
            text: 'Report user',
            style: 'destructive',
            onPress: async () => {
              setModerationBusy(true);
              try {
                await reportUser({
                  reporterUid: viewerUid,
                  targetUid: comment.authorUid,
                  reasonCode: 'harassment',
                  note: `fromComment=${comment.id}`,
                });
                Alert.alert('Reported', `@${commentUser.username} reported.`);
              } catch (error: any) {
                Alert.alert('Report failed', error?.message || 'Unable to submit report.');
              } finally {
                setModerationBusy(false);
              }
            },
          },
          {
            text: isBlocked ? 'Unblock user' : 'Block user',
            style: isBlocked ? 'default' : 'destructive',
            onPress: () => void toggleBlockUser(comment.authorUid, !isBlocked),
          }
        );
      }

      if (actions.length === 1) {
        Alert.alert('Comment options', 'No actions available.');
        return;
      }
      Alert.alert('Comment options', undefined, actions);
    },
    [blockedIds, canDeleteComment, handleDeleteComment, post?.id, resolveUser, toggleBlockUser, viewerUid]
  );

  const openReplyOptions = useCallback(
    (commentId: string, reply: PostReplyRecord) => {
      if (!viewerUid || !post?.id) {
        Alert.alert('Sign in required', 'Please sign in to use moderation tools.');
        return;
      }
      const replyUser = resolveUser(reply.authorUid, reply.authorUsername, reply.authorPhotoURL);
      const isOwnReply = viewerUid === reply.authorUid;
      const isBlocked = blockedIds.has(reply.authorUid);
      const actions: Array<{ text: string; style?: 'default' | 'destructive' | 'cancel'; onPress?: () => void }> = [
        { text: 'Cancel', style: 'cancel' },
      ];

      if (canDeleteReply(reply)) {
        actions.unshift({
          text: 'Delete reply',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Delete reply?', 'This cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  void handleDeleteReply(commentId, reply);
                },
              },
            ]);
          },
        });
      }

      if (!isOwnReply) {
        actions.unshift(
          {
            text: 'Report reply',
            style: 'destructive',
            onPress: async () => {
              setModerationBusy(true);
              try {
                await reportReply({
                  reporterUid: viewerUid,
                  postId: post.id,
                  commentId,
                  replyId: reply.id,
                  reasonCode: 'abusive_reply',
                });
                Alert.alert('Reported', 'Reply reported.');
              } catch (error: any) {
                Alert.alert('Report failed', error?.message || 'Unable to submit report.');
              } finally {
                setModerationBusy(false);
              }
            },
          },
          {
            text: 'Report user',
            style: 'destructive',
            onPress: async () => {
              setModerationBusy(true);
              try {
                await reportUser({
                  reporterUid: viewerUid,
                  targetUid: reply.authorUid,
                  reasonCode: 'harassment',
                  note: `fromReply=${reply.id}`,
                });
                Alert.alert('Reported', `@${replyUser.username} reported.`);
              } catch (error: any) {
                Alert.alert('Report failed', error?.message || 'Unable to submit report.');
              } finally {
                setModerationBusy(false);
              }
            },
          },
          {
            text: isBlocked ? 'Unblock user' : 'Block user',
            style: isBlocked ? 'default' : 'destructive',
            onPress: () => void toggleBlockUser(reply.authorUid, !isBlocked),
          }
        );
      }

      if (actions.length === 1) {
        Alert.alert('Reply options', 'No actions available.');
        return;
      }
      Alert.alert('Reply options', undefined, actions);
    },
    [blockedIds, canDeleteReply, handleDeleteReply, post?.id, resolveUser, toggleBlockUser, viewerUid]
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          flex: 1,
          backgroundColor: colors.bg,
        },
        safeRoot: {
          flex: 1,
          paddingTop: safeTopInset,
        },
        header: {
          minHeight: 52,
          borderBottomWidth: hairline,
          borderBottomColor: colors.borderLight,
          paddingHorizontal: s(3),
          paddingVertical: s(1.4),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff',
        },
        headerBtn: {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
        },
        headerTitle: {
          ...font.h2,
          color: colors.text,
          letterSpacing: 0.15,
        },
        body: {
          flex: 1,
        },
        bodyContent: {
          paddingHorizontal: s(3),
          paddingTop: s(2),
          paddingBottom: !viewerUid ? safeBottomInset + s(3) : s(3),
        },
        avatar: {
          width: 34,
          height: 34,
          borderRadius: 17,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#EEE',
        },
        commentsWrap: {
          paddingTop: s(2),
          gap: s(2),
        },
        commentCard: {
          borderRadius: 16,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.93)',
          paddingHorizontal: s(2),
          paddingVertical: s(1.8),
          gap: s(1.1),
        },
        commentHeader: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: s(1.2),
        },
        identityRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1.3),
          flex: 1,
          minWidth: 0,
        },
        identityText: {
          flex: 1,
          minWidth: 0,
        },
        username: {
          color: colors.text,
          fontWeight: '800',
        },
        meta: {
          ...font.meta,
          color: colors.textDim,
          marginTop: 1,
        },
        commentText: {
          ...font.p,
          color: colors.text,
          lineHeight: 20,
        },
        optionsBtn: {
          width: 30,
          height: 30,
          borderRadius: 15,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        },
        footerRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2),
        },
        inlineAction: {
          height: 28,
          borderRadius: 14,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          paddingHorizontal: s(1.8),
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 6,
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.9)',
        },
        inlineActionText: {
          ...font.meta,
          color: colors.text,
          fontWeight: '700',
        },
        repliesWrap: {
          marginTop: s(0.3),
          borderTopWidth: hairline,
          borderTopColor: colors.borderLight,
          paddingTop: s(1.4),
          gap: s(1.1),
        },
        repliesLoading: {
          ...font.meta,
          color: colors.textDim,
          marginLeft: s(1),
        },
        replyCard: {
          borderRadius: 12,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(246,246,246,0.9)',
          paddingHorizontal: s(1.6),
          paddingVertical: s(1.3),
          gap: s(0.7),
          marginLeft: s(1),
        },
        replyHeader: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: s(1.2),
        },
        replyIdentity: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1),
          flex: 1,
          minWidth: 0,
        },
        replyAvatar: {
          width: 24,
          height: 24,
          borderRadius: 12,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#E8E8E8',
        },
        replyUsername: {
          color: colors.text,
          fontWeight: '700',
        },
        replyText: {
          ...font.p,
          color: colors.text,
          lineHeight: 19,
          marginLeft: 34,
        },
        replyFooter: {
          marginLeft: 34,
          marginTop: s(0.6),
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1),
        },
        emptyWrap: {
          paddingVertical: s(8),
          alignItems: 'center',
          gap: 8,
        },
        composerWrap: {
          borderTopWidth: hairline,
          borderTopColor: colors.borderLight,
          paddingHorizontal: s(3),
          paddingTop: s(1.6),
          paddingBottom: Math.max(safeBottomInset + s(0.5), s(2)),
          gap: 8,
          backgroundColor: isDark ? 'rgba(17,17,20,0.97)' : '#fff',
        },
        replyBanner: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderRadius: 10,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          paddingHorizontal: s(2),
          paddingVertical: s(1.2),
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.9)',
        },
        replyBannerTxt: {
          ...font.meta,
          color: colors.text,
        },
        composerRow: {
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 10,
        },
        input: {
          flex: 1,
          minHeight: 40,
          maxHeight: 110,
          borderRadius: 14,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          paddingHorizontal: s(2),
          paddingVertical: s(1.5),
          color: colors.text,
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fff',
        },
        sendBtn: {
          minWidth: 72,
          height: 40,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: primaryActionBg,
          paddingHorizontal: s(2),
        },
        sendTxt: {
          color: primaryActionFg,
          fontWeight: '800',
        },
      }),
    [colors, isDark, primaryActionBg, primaryActionFg, safeBottomInset, safeTopInset, viewerUid]
  );

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={closeWithSwipe}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, opacity: bgOpacity }]} />
      <Animated.View
        {...panHandlers}
        style={[
          styles.root,
          {
            transform: [{ translateX }],
            opacity,
          },
        ]}
      >
        <KeyboardAvoidingView
          style={styles.root}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <SafeAreaView style={styles.safeRoot} edges={['left', 'right']}>
            <View style={styles.header}>
              <Pressable style={styles.headerBtn} onPress={closeWithSwipe} hitSlop={8}>
                <Ionicons name="chevron-back" size={18} color={colors.text} />
              </Pressable>
              <Text style={styles.headerTitle}>Post</Text>
              <View style={{ width: 34 }} />
            </View>

            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
              scrollEnabled={!isDraggingRef.current}
            >
              {!!post && (
                <FeedPostCard
                  post={{
                    id: post.id,
                    user: {
                      id: post.user.id,
                      username: post.user.username,
                      avatarUri: post.user.avatarUri || '',
                    },
                    modelUri: post.modelUri,
                    likes: Math.max(
                      0,
                      typeof livePostLikeCount === 'number' ? livePostLikeCount : post.likes ?? 0,
                      viewerLikedPost ? 1 : 0
                    ),
                    commentCount: totalComments,
                    caption: post.caption || null,
                    garments: post.garments || [],
                  }}
                  liked={viewerLikedPost}
                  isFollowing={isFollowingPostAuthor}
                  canFollow={canFollowPostAuthor}
                  isOwnPost={Boolean(viewerUid && post.user.id === viewerUid)}
                  optionsBusy={moderationBusy}
                  onOpenProduct={(product) => onOpenProduct?.(product)}
                  onOpenUser={(u) => onOpenUser?.(u)}
                  onToggleFollow={() => onToggleFollowUser?.(post.user.id)}
                  onOpenOptions={openPostOptions}
                />
              )}

              {!viewerUid ? (
                <View style={styles.emptyWrap}>
                  <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.textDim} />
                  <Text style={[font.p, { color: colors.textDim }]}>Sign in to view and add comments.</Text>
                </View>
              ) : loading ? (
                <View style={styles.emptyWrap}>
                  <ActivityIndicator color={colors.text} />
                </View>
              ) : (
                <View style={styles.commentsWrap}>
                  {!comments.length ? (
                    <View style={styles.emptyWrap}>
                      <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.textDim} />
                      <Text style={[font.p, { color: colors.textDim }]}>Start the conversation.</Text>
                    </View>
                  ) : (
                    rankedComments.map((comment) => {
                      const commentUser = resolveUser(
                        comment.authorUid,
                        comment.authorUsername,
                        comment.authorPhotoURL
                      );
                      const replies = rankedRepliesByComment[comment.id] || [];
                      const replyCount = Math.max(replies.length, comment.replyCount || 0);
                      const repliesExpanded = expandedReplies.has(comment.id);
                      const deletingComment = deletingKey === `comment:${comment.id}`;
                      const commentLikeKey = post?.id ? makeCommentLikeKey(post.id, comment.id) : '';
                      const commentLiked = commentLikeKey ? likedCommentKeys.has(commentLikeKey) : false;
                      const commentLikeCount = Math.max(0, comment.likeCount || 0, commentLiked ? 1 : 0);

                      return (
                        <View key={comment.id} style={styles.commentCard}>
                          <View style={styles.commentHeader}>
                            <Pressable style={styles.identityRow} onPress={() => onOpenUser?.(commentUser)}>
                              <UserAvatar uri={commentUser.avatarUri} size={34} style={styles.avatar} />
                              <View style={styles.identityText}>
                                <Text style={styles.username}>@{commentUser.username}</Text>
                                <Text style={styles.meta}>{formatRelativeTime(comment.createdAtMs)}</Text>
                              </View>
                            </Pressable>

                            <Pressable
                              style={styles.optionsBtn}
                              hitSlop={8}
                              disabled={deletingComment}
                              onPress={() => openCommentOptions(comment)}
                            >
                              {deletingComment ? (
                                <ActivityIndicator color={colors.text} size="small" />
                              ) : (
                                <Ionicons name="ellipsis-horizontal" size={16} color={colors.text} />
                              )}
                            </Pressable>
                          </View>

                          <Text style={styles.commentText}>{comment.text}</Text>

                          <View style={styles.footerRow}>
                            <Pressable
                              style={styles.inlineAction}
                              onPress={() => {
                                void toggleCommentLike(comment);
                              }}
                            >
                              <Ionicons
                                name={commentLiked ? 'heart' : 'heart-outline'}
                                size={14}
                                color={commentLiked ? '#e53935' : colors.text}
                              />
                              <Text style={styles.inlineActionText}>{formatCompactCount(commentLikeCount)}</Text>
                            </Pressable>
                            <Pressable
                              style={styles.inlineAction}
                              onPress={() => handleReplyPress(comment.id, commentUser.username)}
                            >
                              <Text style={styles.inlineActionText}>Reply</Text>
                            </Pressable>

                            {replyCount > 0 && (
                              <Pressable style={styles.inlineAction} onPress={() => toggleReplies(comment.id)}>
                                <Text style={styles.inlineActionText}>
                                  {repliesExpanded ? 'Hide replies' : `View replies (${replyCount})`}
                                </Text>
                              </Pressable>
                            )}
                          </View>

                          {repliesExpanded && replies.length > 0 && (
                            <View style={styles.repliesWrap}>
                              {replies.map((reply) => {
                                const replyUser = resolveUser(
                                  reply.authorUid,
                                  reply.authorUsername,
                                  reply.authorPhotoURL
                                );
                                const deletingReply = deletingKey === `reply:${comment.id}:${reply.id}`;
                                const replyLikeKey = post?.id
                                  ? makeReplyLikeKey(post.id, comment.id, reply.id)
                                  : '';
                                const replyLiked = replyLikeKey ? likedReplyKeys.has(replyLikeKey) : false;
                                const replyLikeCount = Math.max(0, reply.likeCount || 0, replyLiked ? 1 : 0);

                                return (
                                  <View key={reply.id} style={styles.replyCard}>
                                    <View style={styles.replyHeader}>
                                      <Pressable style={styles.replyIdentity} onPress={() => onOpenUser?.(replyUser)}>
                                        <UserAvatar uri={replyUser.avatarUri} size={24} style={styles.replyAvatar} />
                                        <View style={styles.identityText}>
                                          <Text style={styles.replyUsername}>@{replyUser.username}</Text>
                                          <Text style={styles.meta}>{formatRelativeTime(reply.createdAtMs)}</Text>
                                        </View>
                                      </Pressable>

                                      <Pressable
                                        style={styles.optionsBtn}
                                        hitSlop={8}
                                        disabled={deletingReply}
                                        onPress={() => openReplyOptions(comment.id, reply)}
                                      >
                                        {deletingReply ? (
                                          <ActivityIndicator color={colors.text} size="small" />
                                        ) : (
                                          <Ionicons name="ellipsis-horizontal" size={15} color={colors.text} />
                                        )}
                                      </Pressable>
                                    </View>

                                    <Text style={styles.replyText}>{reply.text}</Text>
                                    <View style={styles.replyFooter}>
                                      <Pressable
                                        style={styles.inlineAction}
                                        onPress={() => {
                                          void toggleReplyLike(comment.id, reply);
                                        }}
                                      >
                                        <Ionicons
                                          name={replyLiked ? 'heart' : 'heart-outline'}
                                          size={13}
                                          color={replyLiked ? '#e53935' : colors.text}
                                        />
                                        <Text style={styles.inlineActionText}>{formatCompactCount(replyLikeCount)}</Text>
                                      </Pressable>
                                      <Pressable
                                        style={styles.inlineAction}
                                        onPress={() => handleReplyPress(comment.id, replyUser.username)}
                                      >
                                        <Text style={styles.inlineActionText}>Reply</Text>
                                      </Pressable>
                                    </View>
                                  </View>
                                );
                              })}
                            </View>
                          )}
                          {repliesExpanded && !replies.length && replyCount > 0 && (
                            <View style={styles.repliesWrap}>
                              <Text style={styles.repliesLoading}>Loading replies...</Text>
                            </View>
                          )}
                        </View>
                      );
                    })
                  )}
                </View>
              )}
            </ScrollView>

            {!!viewerUid && (
              <View style={styles.composerWrap}>
                {!!replyTarget && (
                  <View style={styles.replyBanner}>
                    <Text style={styles.replyBannerTxt}>Replying to @{replyTarget.username}</Text>
                    <Pressable onPress={() => setReplyTarget(null)}>
                      <Ionicons name="close" size={16} color={colors.text} />
                    </Pressable>
                  </View>
                )}

                <View style={styles.composerRow}>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={replyTarget ? `Reply to @${replyTarget.username}` : 'Write a comment'}
                    placeholderTextColor={colors.textDim}
                    maxLength={MAX_COMMENT_LENGTH}
                    multiline
                    style={styles.input}
                  />

                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    <Text style={[font.meta, { color: colors.textDim }]}>{remainingChars}</Text>
                  <Pressable
                    style={[styles.sendBtn, (!draft.trim() || sending) && { opacity: 0.65 }]}
                    disabled={!draft.trim() || sending}
                    onPress={handleSubmit}
                  >
                    {sending ? (
                      <ActivityIndicator color={primaryActionFg} />
                    ) : (
                      <Text style={styles.sendTxt}>Send</Text>
                    )}
                  </Pressable>
                </View>
              </View>
              </View>
            )}
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Animated.View>
    </Modal>
  );
}
