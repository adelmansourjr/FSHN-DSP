import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { font, hairline, radius, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import {
  createCommentReply,
  createPostComment,
  subscribeCommentReplies,
  subscribePostComments,
  type PostCommentRecord,
  type PostReplyRecord,
} from '../../lib/postComments';
import UserAvatar from '../UserAvatar';

type KnownUser = {
  id: string;
  username: string;
  avatarUri?: string | null;
  bio?: string;
};

type Props = {
  visible: boolean;
  postId?: string | null;
  viewerUid?: string | null;
  viewerUsername?: string | null;
  viewerPhotoURL?: string | null;
  knownUsers?: Record<string, KnownUser>;
  onOpenUser?: (user: KnownUser) => void;
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

export default function CommentsSheet({
  visible,
  postId,
  viewerUid,
  viewerUsername,
  viewerPhotoURL,
  knownUsers,
  onOpenUser,
  onCountChange,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const primaryActionBg = isDark ? '#fff' : colors.text;
  const primaryActionFg = isDark ? colors.bg : '#fff';
  const [comments, setComments] = useState<PostCommentRecord[]>([]);
  const [repliesByComment, setRepliesByComment] = useState<Record<string, PostReplyRecord[]>>({});
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const remainingChars = Math.max(0, MAX_COMMENT_LENGTH - draft.length);

  const resolveUser = useCallback(
    (uid: string, username?: string | null, avatarUri?: string | null): KnownUser => {
      return knownUsers?.[uid] || fallbackUser(uid, username, avatarUri);
    },
    [knownUsers]
  );

  useEffect(() => {
    if (!visible) {
      setDraft('');
      setComments([]);
      setRepliesByComment({});
      setReplyTarget(null);
      setExpandedReplies(new Set());
      setLoading(false);
      setSending(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !postId || !viewerUid) {
      setComments([]);
      setRepliesByComment({});
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsub = subscribePostComments(
      postId,
      (items) => {
        setLoading(false);
        setComments(items);
      },
      (error) => {
        setLoading(false);
        if (error?.code === 'permission-denied') {
          setComments([]);
          return;
        }
        console.warn('[CommentsSheet] comments subscription failed', error);
      }
    );
    return () => unsub();
  }, [postId, viewerUid, visible]);

  useEffect(() => {
    if (!visible || !postId || !viewerUid || !comments.length) {
      setRepliesByComment({});
      return;
    }
    const unsubs: Array<() => void> = [];
    comments.forEach((comment) => {
      const unsub = subscribeCommentReplies(
        postId,
        comment.id,
        (items) => {
          setRepliesByComment((prev) => ({ ...prev, [comment.id]: items }));
        },
        (error) => {
          if (error?.code === 'permission-denied') {
            setRepliesByComment((prev) => ({ ...prev, [comment.id]: [] }));
            return;
          }
          console.warn('[CommentsSheet] replies subscription failed', error);
        }
      );
      unsubs.push(unsub);
    });
    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [comments, postId, viewerUid, visible]);

  const totalComments = useMemo(() => comments.length, [comments.length]);

  useEffect(() => {
    onCountChange?.(totalComments);
  }, [onCountChange, totalComments]);

  const toggleReplies = useCallback((commentId: string) => {
    setExpandedReplies((prev) => {
      const next = new Set(prev);
      if (next.has(commentId)) next.delete(commentId);
      else next.add(commentId);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!viewerUid || !postId || sending) return;
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
          postId,
          commentId: replyTarget.commentId,
          authorUid: viewerUid,
          authorUsername: viewerUsername,
          authorPhotoURL: viewerPhotoURL,
          text,
        });
      } else {
        await createPostComment({
          postId,
          authorUid: viewerUid,
          authorUsername: viewerUsername,
          authorPhotoURL: viewerPhotoURL,
          text,
        });
      }
      setDraft('');
      setReplyTarget(null);
    } catch (error) {
      console.warn('[CommentsSheet] submit failed', error);
    } finally {
      setSending(false);
    }
  }, [draft, postId, replyTarget, sending, viewerPhotoURL, viewerUid, viewerUsername]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(0,0,0,0.35)',
        },
        wrapper: {
          ...StyleSheet.absoluteFillObject,
          justifyContent: 'flex-end',
        },
        sheet: {
          maxHeight: '84%',
          borderTopLeftRadius: radius.card,
          borderTopRightRadius: radius.card,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(17,17,20,0.94)' : 'rgba(255,255,255,0.94)',
          overflow: 'hidden',
        },
        header: {
          paddingTop: s(3),
          paddingHorizontal: s(3),
          paddingBottom: s(2),
          borderBottomWidth: hairline,
          borderBottomColor: colors.borderLight,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        title: { ...font.h2, color: colors.text },
        closeBtn: {
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
        },
        listContent: {
          paddingHorizontal: s(3),
          paddingTop: s(2),
          paddingBottom: s(3),
          gap: s(2),
        },
        commentRow: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: s(2),
        },
        avatar: {
          width: 34,
          height: 34,
          borderRadius: 17,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#EEE',
        },
        bubbleWrap: { flex: 1, minWidth: 0, gap: 6 },
        bubble: {
          borderRadius: 14,
          paddingHorizontal: s(2),
          paddingVertical: s(1.5),
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.85)',
        },
        username: { fontWeight: '800', color: colors.text },
        text: { ...font.p, color: colors.text, marginTop: 2 },
        metaRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
        meta: { ...font.meta, color: colors.textDim },
        replyBtn: { paddingVertical: 2 },
        replyTxt: { ...font.meta, color: colors.text, fontWeight: '700' },
        repliesWrap: {
          marginTop: 6,
          marginLeft: s(2),
          borderLeftWidth: hairline,
          borderLeftColor: colors.borderLight,
          paddingLeft: s(2),
          gap: s(1.2),
        },
        replyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: s(1.6) },
        replyAvatar: {
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#EEE',
          marginTop: 2,
        },
        replyBubble: {
          flex: 1,
          minWidth: 0,
          borderRadius: 12,
          paddingHorizontal: s(1.8),
          paddingVertical: s(1.1),
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.78)',
        },
        replyToggle: { marginTop: 2 },
        replyToggleTxt: { ...font.meta, color: colors.text, fontWeight: '700' },
        emptyWrap: { paddingVertical: s(10), alignItems: 'center', gap: 8 },
        composerWrap: {
          borderTopWidth: hairline,
          borderTopColor: colors.borderLight,
          paddingHorizontal: s(3),
          paddingTop: s(1.6),
          paddingBottom: Math.max(insets.bottom, s(2)),
          gap: 8,
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
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.82)',
        },
        replyBannerTxt: { ...font.meta, color: colors.text },
        composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
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
          minWidth: 66,
          height: 40,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: primaryActionBg,
          paddingHorizontal: s(2),
        },
        sendTxt: { color: primaryActionFg, fontWeight: '800' },
      }),
    [colors, insets.bottom, isDark, primaryActionBg, primaryActionFg]
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.wrapper} pointerEvents="box-none">
        <BlurView tint={isDark ? 'dark' : 'light'} intensity={32} style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Comments ({totalComments})</Text>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <Ionicons name="close" size={18} color={colors.text} />
            </Pressable>
          </View>

          {!viewerUid ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.textDim} />
                <Text style={[font.p, { color: colors.textDim }]}>Sign in to view comments.</Text>
            </View>
          ) : loading ? (
            <View style={styles.emptyWrap}>
              <ActivityIndicator color={colors.text} />
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.listContent}>
              {!comments.length ? (
                <View style={styles.emptyWrap}>
                  <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.textDim} />
                  <Text style={[font.p, { color: colors.textDim }]}>Start the conversation.</Text>
                </View>
              ) : (
                comments.map((comment) => {
                  const commentUser = resolveUser(
                    comment.authorUid,
                    comment.authorUsername,
                    comment.authorPhotoURL
                  );
                  const replies = repliesByComment[comment.id] || [];
                  const collapsed = replies.length > 2 && !expandedReplies.has(comment.id);
                  const visibleReplies = collapsed ? replies.slice(0, 2) : replies;
                  return (
                    <View key={comment.id} style={styles.commentRow}>
                      <Pressable onPress={() => onOpenUser?.(commentUser)}>
                        <UserAvatar uri={commentUser.avatarUri} size={34} style={styles.avatar} />
                      </Pressable>
                      <View style={styles.bubbleWrap}>
                        <View style={styles.bubble}>
                          <Pressable onPress={() => onOpenUser?.(commentUser)}>
                            <Text style={styles.username}>@{commentUser.username}</Text>
                          </Pressable>
                          <Text style={styles.text}>{comment.text}</Text>
                        </View>
                        <View style={styles.metaRow}>
                          <Text style={styles.meta}>{formatRelativeTime(comment.createdAtMs)}</Text>
                          <Pressable
                            style={styles.replyBtn}
                            onPress={() =>
                              setReplyTarget({ commentId: comment.id, username: commentUser.username })
                            }
                          >
                            <Text style={styles.replyTxt}>Reply</Text>
                          </Pressable>
                        </View>

                        {!!visibleReplies.length && (
                          <View style={styles.repliesWrap}>
                            {visibleReplies.map((reply) => {
                              const replyUser = resolveUser(
                                reply.authorUid,
                                reply.authorUsername,
                                reply.authorPhotoURL
                              );
                              return (
                                <View key={reply.id} style={styles.replyRow}>
                                  <Pressable onPress={() => onOpenUser?.(replyUser)}>
                                    <UserAvatar uri={replyUser.avatarUri} size={26} style={styles.replyAvatar} />
                                  </Pressable>
                                  <View style={styles.replyBubble}>
                                    <Pressable onPress={() => onOpenUser?.(replyUser)}>
                                      <Text style={styles.username}>@{replyUser.username}</Text>
                                    </Pressable>
                                    <Text style={styles.text}>{reply.text}</Text>
                                    <Text style={styles.meta}>{formatRelativeTime(reply.createdAtMs)}</Text>
                                  </View>
                                </View>
                              );
                            })}
                          </View>
                        )}

                        {replies.length > 2 && (
                          <Pressable style={styles.replyToggle} onPress={() => toggleReplies(comment.id)}>
                            <Text style={styles.replyToggleTxt}>
                              {expandedReplies.has(comment.id)
                                ? 'Hide replies'
                                : `View ${replies.length - 2} more repl${replies.length - 2 > 1 ? 'ies' : 'y'}`}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>
          )}

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
        </BlurView>
      </View>
    </Modal>
  );
}
