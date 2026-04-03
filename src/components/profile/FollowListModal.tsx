import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import {
  collection,
  doc,
  documentId,
  getDocs,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { font, hairline, radius, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import { db } from '../../lib/firebase';
import { syncNotificationEvent } from '../../lib/notifications';
import type { SearchUser } from '../HeaderSearchOverlay';
import UserAvatar from '../UserAvatar';

type Mode = 'followers' | 'following';

type Props = {
  visible: boolean;
  mode: Mode;
  targetUid: string;
  viewerUid?: string | null;
  isOwner?: boolean;
  onClose: () => void;
  onSelectUser?: (user: SearchUser) => void;
};

const chunk = <T,>(items: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export default function FollowListModal({
  visible,
  mode,
  targetUid,
  viewerUid,
  isOwner = false,
  onClose,
  onSelectUser,
}: Props) {
  const { colors, isDark } = useTheme();
  const [edgeIds, setEdgeIds] = useState<string[]>([]);
  const [users, setUsers] = useState<SearchUser[]>([]);
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  const [pendingRemoved, setPendingRemoved] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const allowRemoveFollowers = isOwner && mode === 'followers';

  useEffect(() => {
    if (!visible) {
      setEdgeIds([]);
      setUsers([]);
      setPendingRemoved(new Set());
      setBusyIds(new Set());
      return;
    }
    if (!targetUid) return;
    const edgesRef = collection(db, 'users', targetUid, mode);
    const edgesQuery = query(edgesRef, limit(500));
    const unsub = onSnapshot(
      edgesQuery,
      (snap) => setEdgeIds(snap.docs.map((d) => d.id)),
      (error) => {
        if (error?.code === 'permission-denied') {
          setEdgeIds([]);
          return;
        }
        console.warn('[FollowListModal] edge listener error', error);
      }
    );
    return () => unsub();
  }, [mode, targetUid, visible]);

  useEffect(() => {
    if (!visible) return;
    if (!edgeIds.length) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const out: SearchUser[] = [];
        const chunks = chunk(edgeIds, 10);
        for (const ids of chunks) {
          const usersRef = collection(db, 'users');
          const snap = await getDocs(query(usersRef, where(documentId(), 'in', ids)));
          snap.docs.forEach((docSnap) => {
            const data = docSnap.data() as any;
            out.push({
              id: docSnap.id,
              username: data?.username || docSnap.id,
              displayName: data?.displayName || null,
              avatarUri: data?.photoURL || null,
              bio: data?.bio || null,
            });
          });
        }
        if (!cancelled) setUsers(out);
      } catch (err) {
        console.warn('[FollowListModal] user fetch failed', err);
        if (!cancelled) setUsers([]);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [edgeIds, visible]);

  useEffect(() => {
    if (!visible) return;
    if (!viewerUid) {
      setFollowingIds(new Set());
      return;
    }
    const followingRef = collection(db, 'users', viewerUid, 'following');
    const unsub = onSnapshot(
      followingRef,
      (snap) => setFollowingIds(new Set(snap.docs.map((d) => d.id))),
      (error) => {
        if (error?.code === 'permission-denied') {
          setFollowingIds(new Set());
          return;
        }
        console.warn('[FollowListModal] following listener error', error);
      }
    );
    return () => unsub();
  }, [viewerUid, visible]);

  const toggleFollow = useCallback(
    async (targetId: string, nextFollow: boolean) => {
      if (!viewerUid || viewerUid === targetId) return;
      setBusyIds((prev) => new Set(prev).add(targetId));
      setFollowingIds((prev) => {
        const next = new Set(prev);
        if (nextFollow) next.add(targetId);
        else next.delete(targetId);
        return next;
      });
      try {
        const followingRef = doc(db, 'users', viewerUid, 'following', targetId);
        const followerRef = doc(db, 'users', targetId, 'followers', viewerUid);
        const viewerRef = doc(db, 'users', viewerUid);
        const targetRef = doc(db, 'users', targetId);
        await runTransaction(db, async (tx) => {
          const [viewerSnap, targetSnap] = await Promise.all([
            tx.get(viewerRef),
            tx.get(targetRef),
          ]);
          if (!viewerSnap.exists() || !targetSnap.exists()) {
            throw new Error('missing-user');
          }
          const currentFollowing = Number(viewerSnap.data()?.followingCount ?? 0);
          const targetFollowers = Number(targetSnap.data()?.followersCount ?? 0);
          if (nextFollow) {
            tx.set(followingRef, { createdAt: serverTimestamp() });
            tx.set(followerRef, { createdAt: serverTimestamp() });
            tx.update(viewerRef, { followingCount: currentFollowing + 1 });
            tx.update(targetRef, { followersCount: targetFollowers + 1 });
          } else {
            tx.delete(followingRef);
            tx.delete(followerRef);
            tx.update(viewerRef, { followingCount: Math.max(0, currentFollowing - 1) });
            tx.update(targetRef, { followersCount: Math.max(0, targetFollowers - 1) });
          }
        });
        void syncNotificationEvent({
          type: 'follow',
          enabled: nextFollow,
          actorUid: viewerUid,
          targetUid,
        });
      } catch (err) {
        console.warn('[FollowListModal] toggle follow failed', err);
        setFollowingIds((prev) => {
          const next = new Set(prev);
          if (nextFollow) next.delete(targetId);
          else next.add(targetId);
          return next;
        });
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
      }
    },
    [viewerUid]
  );

  const toggleRemoveFollower = useCallback((targetId: string) => {
    setPendingRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(targetId)) next.delete(targetId);
      else next.add(targetId);
      return next;
    });
  }, []);

  const title = mode === 'followers' ? 'Followers' : 'Following';
  const emptyLabel = mode === 'followers' ? 'No followers yet.' : 'Not following anyone yet.';

  const styles = useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(0,0,0,0.35)',
        },
        centerWrap: {
          ...StyleSheet.absoluteFillObject,
          justifyContent: 'flex-end',
        },
        sheet: {
          maxHeight: '82%',
          borderTopLeftRadius: radius.card,
          borderTopRightRadius: radius.card,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(17,17,20,0.92)' : 'rgba(255,255,255,0.92)',
          paddingTop: s(3),
          paddingHorizontal: s(3),
          overflow: 'hidden',
        },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingBottom: s(2),
          borderBottomWidth: hairline,
          borderBottomColor: colors.borderLight,
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
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: s(2),
          borderBottomWidth: hairline,
          borderBottomColor: colors.borderLight,
        },
        rowMain: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2),
          flex: 1,
          minWidth: 0,
        },
        avatar: {
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#EEE',
        },
        meta: { flex: 1, minWidth: 0 },
        username: { fontWeight: '900', color: colors.text },
        sub: { ...font.p, color: colors.textDim },
        action: {
          paddingHorizontal: s(3),
          height: 30,
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.65)',
        },
        actionPrimary: { backgroundColor: isDark ? '#fff' : colors.text, borderColor: isDark ? '#fff' : colors.text },
        actionText: { fontSize: 12, fontWeight: '800', color: colors.text },
        actionTextPrimary: { color: isDark ? colors.bg : '#fff' },
        removeBtn: {
          paddingHorizontal: s(2),
          height: 30,
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: 'transparent',
        },
        removeText: { fontSize: 11, fontWeight: '800', color: colors.textDim },
        empty: {
          paddingVertical: s(6),
          alignItems: 'center',
          gap: s(1.5),
        },
      }),
    [colors, isDark]
  );

  const renderUser = (u: SearchUser) => {
    const isFollowing = followingIds.has(u.id);
    const isBusy = busyIds.has(u.id);
    const isRemoved = pendingRemoved.has(u.id);
    const showFollow = viewerUid && viewerUid !== u.id;
    return (
      <View key={u.id} style={[styles.row, isRemoved && { opacity: 0.45 }]}>
        <Pressable
          disabled={!onSelectUser}
          onPress={() => onSelectUser?.(u)}
          style={({ pressed }) => [
            styles.rowMain,
            onSelectUser && pressed && { opacity: 0.75, transform: [{ scale: 0.99 }] },
          ]}
        >
          <UserAvatar uri={u.avatarUri} size={44} style={styles.avatar} transition={120} />
          <View style={styles.meta}>
            <Text style={styles.username} numberOfLines={1}>@{u.username}</Text>
            {!!u.displayName && <Text style={styles.sub} numberOfLines={1}>{u.displayName}</Text>}
            {!!u.bio && <Text style={styles.sub} numberOfLines={1}>{u.bio}</Text>}
          </View>
        </Pressable>
        {allowRemoveFollowers && (
          <Pressable
            onPress={() => toggleRemoveFollower(u.id)}
            style={({ pressed }) => [
              styles.removeBtn,
              pressed && { transform: [{ scale: 0.97 }] },
            ]}
          >
            <Text style={styles.removeText}>{isRemoved ? 'Undo' : 'Remove'}</Text>
          </Pressable>
        )}
        {showFollow && (
          <Pressable
            disabled={isBusy || isRemoved}
            onPress={() => toggleFollow(u.id, !isFollowing)}
            style={({ pressed }) => [
              styles.action,
              isFollowing && styles.actionPrimary,
              (pressed || isBusy || isRemoved) && { opacity: isRemoved ? 0.4 : 0.85, transform: [{ scale: 0.97 }] },
            ]}
          >
            {isBusy ? (
              <ActivityIndicator size="small" color={isFollowing ? (isDark ? colors.bg : '#fff') : colors.text} />
            ) : (
              <Text style={[styles.actionText, isFollowing && styles.actionTextPrimary]}>
                {isFollowing ? 'Following' : 'Follow'}
              </Text>
            )}
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFillObject} />
      </Pressable>

      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <Ionicons name="close" size={18} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: s(4) }}>
            {!users.length && (
              <View style={styles.empty}>
                <Ionicons name="people-outline" size={18} color={colors.textDim} />
                <Text style={[font.p, { color: colors.textDim }]}>{emptyLabel}</Text>
              </View>
            )}
            {users.map(renderUser)}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
