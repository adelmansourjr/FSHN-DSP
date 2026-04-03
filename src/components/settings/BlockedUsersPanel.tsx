import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { collection, getDocs, limit, onSnapshot, query, where } from 'firebase/firestore';
import MinimalHeader from '../MinimalHeader';
import { font, hairline, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import { db } from '../../lib/firebase';
import { unblockUser } from '../../lib/postModeration';

type Props = {
  viewerUid?: string | null;
};

type BlockedEntry = {
  uid: string;
  reason: string;
  createdAtMs: number | null;
};

const chunk = <T,>(items: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const toMillis = (value: any) => {
  if (!value) return null;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number') return value;
  if (typeof value?.seconds === 'number') return value.seconds * 1000;
  if (typeof value?._seconds === 'number') return value._seconds * 1000;
  return null;
};

export default function BlockedUsersPanel({ viewerUid }: Props) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const [open, setOpen] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<BlockedEntry[]>([]);
  const [blockedNames, setBlockedNames] = useState<Record<string, string>>({});
  const [blockedBusyIds, setBlockedBusyIds] = useState<Set<string>>(new Set());
  const [blockedLoading, setBlockedLoading] = useState(false);

  const theme = useMemo(
    () => ({
      bg: colors.bg,
      cardBg: isDark ? 'rgba(17,17,20,0.85)' : 'rgba(255,255,255,0.85)',
      cardBorder: isDark ? 'rgba(255,255,255,0.08)' : colors.borderLight,
      text: colors.text,
      textDim: colors.textDim,
      inputBg: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.85)',
    }),
    [colors, isDark]
  );

  useEffect(() => {
    if (!viewerUid) {
      setBlockedUsers([]);
      setBlockedNames({});
      setBlockedLoading(false);
      return;
    }
    setBlockedLoading(true);
    const blockedRef = collection(db, 'users', viewerUid, 'blocked');
    const blockedQuery = query(blockedRef, limit(500));
    const unsub = onSnapshot(
      blockedQuery,
      (snap) => {
        const entries = snap.docs
          .map((docSnap) => {
            const data = docSnap.data() as any;
            return {
              uid: docSnap.id,
              reason: String(data?.reason || ''),
              createdAtMs: toMillis(data?.createdAt),
            } as BlockedEntry;
          })
          .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        setBlockedUsers(entries);
        setBlockedLoading(false);
      },
      (error) => {
        if (error?.code !== 'permission-denied') {
          console.warn('[BlockedUsersPanel] blocked listener failed', error);
        }
        setBlockedUsers([]);
        setBlockedNames({});
        setBlockedLoading(false);
      }
    );
    return () => unsub();
  }, [viewerUid]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!blockedUsers.length) {
        setBlockedNames({});
        return;
      }
      try {
        const ids = blockedUsers.map((item) => item.uid);
        const chunks = chunk(ids, 10);
        const map: Record<string, string> = {};
        for (const idsChunk of chunks) {
          const usernamesRef = collection(db, 'usernames');
          const snap = await getDocs(query(usernamesRef, where('uid', 'in', idsChunk)));
          snap.docs.forEach((docSnap) => {
            const data = docSnap.data() as any;
            const uid = String(data?.uid || '');
            if (uid) map[uid] = docSnap.id;
          });
        }
        if (!cancelled) setBlockedNames(map);
      } catch (error) {
        if (!cancelled) {
          console.warn('[BlockedUsersPanel] username lookup failed', error);
          setBlockedNames({});
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [blockedUsers]);

  const close = useCallback(() => setOpen(false), []);

  const performUnblock = useCallback(
    async (targetUid: string) => {
      if (!viewerUid || !targetUid || blockedBusyIds.has(targetUid)) return;
      setBlockedBusyIds((prev) => {
        const next = new Set(prev);
        next.add(targetUid);
        return next;
      });
      try {
        await unblockUser({ viewerUid, targetUid });
      } catch (error: any) {
        Alert.alert('Unblock failed', error?.message || 'Could not unblock this user right now.');
      } finally {
        setBlockedBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(targetUid);
          return next;
        });
      }
    },
    [blockedBusyIds, viewerUid]
  );

  const confirmUnblock = useCallback(
    (targetUid: string) => {
      const username = blockedNames[targetUid] || targetUid.slice(0, 10);
      Alert.alert('Unblock user', `Unblock @${username}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          style: 'destructive',
          onPress: () => {
            void performUnblock(targetUid);
          },
        },
      ]);
    },
    [blockedNames, performUnblock]
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panelRow: {
          minHeight: 46,
          borderRadius: 12,
          borderWidth: hairline,
          paddingHorizontal: s(2),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        panelRowLeft: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1.4),
        },
        panelRowRight: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1),
        },
        panelRowText: {
          fontSize: 14,
          fontWeight: '700',
        },
        panelMetaText: {
          ...font.meta,
          fontWeight: '700',
        },
        blockedRoot: {
          flex: 1,
        },
        blockedState: {
          marginTop: s(4),
          alignItems: 'center',
          justifyContent: 'center',
          gap: s(1.4),
        },
        blockedStateText: {
          ...font.p,
        },
        blockedRow: {
          borderRadius: 14,
          borderWidth: hairline,
          paddingHorizontal: s(2),
          paddingVertical: s(1.5),
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1.6),
          justifyContent: 'space-between',
        },
        blockedRowMain: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1.4),
          flex: 1,
          minWidth: 0,
        },
        blockedAvatar: {
          width: 36,
          height: 36,
          borderRadius: 18,
          borderWidth: hairline,
          alignItems: 'center',
          justifyContent: 'center',
        },
        blockedName: {
          fontSize: 14,
          fontWeight: '800',
        },
        blockedSub: {
          ...font.meta,
          marginTop: 1,
        },
        unblockBtn: {
          minWidth: 84,
          height: 32,
          borderRadius: 999,
          borderWidth: hairline,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: s(2),
        },
        unblockTxt: {
          fontSize: 12,
          fontWeight: '800',
        },
      }),
    []
  );

  return (
    <>
      <Pressable
        disabled={!viewerUid}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.panelRow,
          { borderColor: theme.cardBorder, backgroundColor: theme.inputBg },
          pressed && { opacity: 0.9, transform: [{ scale: 0.995 }] },
          !viewerUid && { opacity: 0.65 },
        ]}
      >
        <View style={styles.panelRowLeft}>
          <Ionicons name="ban-outline" size={16} color={theme.text} />
          <Text style={[styles.panelRowText, { color: theme.text }]}>Blocked users</Text>
        </View>
        <View style={styles.panelRowRight}>
          <Text style={[styles.panelMetaText, { color: theme.textDim }]}>{blockedUsers.length}</Text>
          <Ionicons name="chevron-forward" size={15} color={theme.textDim} />
        </View>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={close}>
        <View style={[styles.blockedRoot, { backgroundColor: theme.bg }]}>
          <MinimalHeader
            title="Blocked Users"
            leftIcon="chevron-back"
            onLeftPress={close}
            leftA11yLabel="Back"
            rightIcon="close"
            onRightPress={close}
            rightA11yLabel="Close blocked users"
          />

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: s(3),
              paddingTop: s(2),
              paddingBottom: insets.bottom + s(8),
              gap: s(1.5),
            }}
          >
            {blockedLoading ? (
              <View style={styles.blockedState}>
                <ActivityIndicator color={theme.text} />
                <Text style={[styles.blockedStateText, { color: theme.textDim }]}>Loading blocked users...</Text>
              </View>
            ) : !blockedUsers.length ? (
              <View style={styles.blockedState}>
                <Ionicons name="checkmark-circle-outline" size={18} color={theme.textDim} />
                <Text style={[styles.blockedStateText, { color: theme.textDim }]}>You have no blocked users.</Text>
              </View>
            ) : (
              blockedUsers.map((entry) => {
                const username = blockedNames[entry.uid];
                const label = username ? `@${username}` : entry.uid;
                const isBusy = blockedBusyIds.has(entry.uid);
                const subtitle = entry.reason ? `Reason: ${entry.reason}` : 'Blocked user';
                return (
                  <View
                    key={entry.uid}
                    style={[
                      styles.blockedRow,
                      { borderColor: theme.cardBorder, backgroundColor: theme.cardBg },
                    ]}
                  >
                    <View style={styles.blockedRowMain}>
                      <View
                        style={[
                          styles.blockedAvatar,
                          { backgroundColor: theme.inputBg, borderColor: theme.cardBorder },
                        ]}
                      >
                        <Ionicons name="person-outline" size={16} color={theme.textDim} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[styles.blockedName, { color: theme.text }]} numberOfLines={1}>
                          {label}
                        </Text>
                        <Text style={[styles.blockedSub, { color: theme.textDim }]} numberOfLines={1}>
                          {subtitle}
                        </Text>
                      </View>
                    </View>
                    <Pressable
                      disabled={isBusy}
                      onPress={() => confirmUnblock(entry.uid)}
                      style={({ pressed }) => [
                        styles.unblockBtn,
                        { borderColor: theme.cardBorder, backgroundColor: theme.inputBg },
                        (pressed || isBusy) && { opacity: 0.75 },
                      ]}
                    >
                      {isBusy ? (
                        <ActivityIndicator size="small" color={theme.text} />
                      ) : (
                        <Text style={[styles.unblockTxt, { color: theme.text }]}>Unblock</Text>
                      )}
                    </Pressable>
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
