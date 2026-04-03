import { doc, runTransaction, serverTimestamp, updateDoc, type Timestamp } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { db, storage } from './firebase';
import { PRIVACY_POLICY_VERSION } from './privacyPolicy';
import {
  emptyShippingAddress,
  sanitizeShippingAddress,
  type ShippingAddress,
} from './shippingAddress';

export type SignupProfileInput = {
  uid: string;
  username: string;
  displayName: string;
  dateOfBirth: string;
  isAdult: boolean;
  bio?: string;
  photoURL?: string;
  sexPreference?: SexPreference;
  shippingAddress: ShippingAddress;
  legalPolicyVersionAccepted: string;
};

export type SexPreference = 'male' | 'female' | 'all';

export class UserProfile {
  username: string;
  displayName: string;
  dateOfBirth: string;
  isAdult: boolean;
  createdAt!: Timestamp;
  lastActiveAt!: Timestamp;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  listingsCount: number;
  tryOnCount: number;
  status: 'active' | 'disabled' | 'banned' | string;
  strikesCount: number;
  photoURL: string;
  bio: string;
  sexPreference?: SexPreference;
  shippingAddress?: ShippingAddress;
  privacyPolicyVersion?: string;
  privacyAcceptedAt?: Timestamp;
  termsVersion?: string;
  termsAcceptedAt?: Timestamp;

  constructor(input: Partial<UserProfile> = {}) {
    this.username = input.username || '';
    this.displayName = input.displayName || '';
    this.dateOfBirth = input.dateOfBirth || '';
    this.isAdult = Boolean(input.isAdult);
    this.createdAt = input.createdAt as Timestamp;
    this.lastActiveAt = input.lastActiveAt as Timestamp;
    this.followersCount = Number(input.followersCount ?? 0) || 0;
    this.followingCount = Number(input.followingCount ?? 0) || 0;
    this.postsCount = Number(input.postsCount ?? 0) || 0;
    this.listingsCount = Number(input.listingsCount ?? 0) || 0;
    this.tryOnCount = Number(input.tryOnCount ?? 0) || 0;
    this.status = input.status || 'active';
    this.strikesCount = Number(input.strikesCount ?? 0) || 0;
    this.photoURL = input.photoURL || '';
    this.bio = input.bio || '';
    this.sexPreference = input.sexPreference;
    this.shippingAddress = input.shippingAddress;
    this.privacyPolicyVersion = input.privacyPolicyVersion;
    this.privacyAcceptedAt = input.privacyAcceptedAt;
    this.termsVersion = input.termsVersion;
    this.termsAcceptedAt = input.termsAcceptedAt;
  }

  static normalizeSexPreference(value?: SexPreference) {
    return value === 'male' || value === 'female' || value === 'all' ? value : 'all';
  }
}

export type ProfileUpdateInput = {
  username?: string;
  displayName: string;
  bio: string;
  photoURL?: string;
  sexPreference?: SexPreference;
  shippingAddress?: ShippingAddress;
};

export const normalizeUsername = (value: string) => value.trim().toLowerCase();
export const USERNAME_RE = /^[a-zA-Z0-9._]{3,20}$/;

export const isDobString = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value.trim());

export const isAdultFromDob = (value: string) => {
  if (!isDobString(value)) return false;
  const [y, m, d] = value.split('-').map((v) => Number(v));
  if (!y || !m || !d) return false;
  const dob = new Date(y, m - 1, d);
  if (Number.isNaN(dob.getTime())) return false;
  const today = new Date();
  let age = today.getFullYear() - y;
  const hasHadBirthday =
    today.getMonth() > m - 1 || (today.getMonth() === m - 1 && today.getDate() >= d);
  if (!hasHadBirthday) age -= 1;
  return age >= 18;
};

export class UserProfileService {
  async createUserProfile(input: SignupProfileInput) {
    const username = normalizeUsername(input.username);
    const userRef = doc(db, 'users', input.uid);
    const usernameRef = doc(db, 'usernames', username);
    const nextShippingAddress = sanitizeShippingAddress(input.shippingAddress || emptyShippingAddress());
    const acceptedLegalVersion = String(input.legalPolicyVersionAccepted || '').trim();

    if (!acceptedLegalVersion) {
      const error = new Error('PRIVACY_ACCEPTANCE_REQUIRED');
      (error as any).code = 'PRIVACY_ACCEPTANCE_REQUIRED';
      throw error;
    }

    const normalizedSexPreference = UserProfile.normalizeSexPreference(input.sexPreference);

    const profileDoc = {
      username,
      displayName: input.displayName.trim(),
      dateOfBirth: input.dateOfBirth.trim(),
      isAdult: input.isAdult,
      createdAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
      followersCount: 0,
      followingCount: 0,
      postsCount: 0,
      listingsCount: 0,
      tryOnCount: 0,
      status: 'active',
      strikesCount: 0,
      photoURL: input.photoURL ?? '',
      bio: (input.bio ?? '').trim(),
      sexPreference: normalizedSexPreference,
      shippingAddress: nextShippingAddress,
      privacyPolicyVersion: acceptedLegalVersion || PRIVACY_POLICY_VERSION,
      privacyAcceptedAt: serverTimestamp(),
      termsVersion: acceptedLegalVersion || PRIVACY_POLICY_VERSION,
      termsAcceptedAt: serverTimestamp(),
    };

    await runTransaction(db, async (tx) => {
      const usernameSnap = await tx.get(usernameRef);
      if (usernameSnap.exists()) {
        const error = new Error('USERNAME_TAKEN');
        (error as any).code = 'USERNAME_TAKEN';
        throw error;
      }
      tx.set(usernameRef, {
        uid: input.uid,
        createdAt: serverTimestamp(),
      });
      tx.set(userRef, profileDoc);
    });
  }

  async updateUserProfile(uid: string, input: ProfileUpdateInput) {
    const userRef = doc(db, 'users', uid);
    const nextSexPreference =
      input.sexPreference === 'male' || input.sexPreference === 'female' || input.sexPreference === 'all'
        ? input.sexPreference
        : undefined;
    const nextShippingAddress =
      input.shippingAddress ? sanitizeShippingAddress(input.shippingAddress) : undefined;
    const payloadBase = {
      displayName: input.displayName.trim(),
      bio: input.bio.trim(),
      ...(input.photoURL ? { photoURL: input.photoURL } : {}),
      ...(nextSexPreference ? { sexPreference: nextSexPreference } : {}),
      ...(nextShippingAddress ? { shippingAddress: nextShippingAddress } : {}),
      lastActiveAt: serverTimestamp(),
    };
    const nextUsername =
      typeof input.username === 'string' ? normalizeUsername(input.username) : null;

    if (!nextUsername) {
      await updateDoc(userRef, payloadBase);
      return;
    }
    if (!USERNAME_RE.test(nextUsername)) {
      const error = new Error('INVALID_USERNAME');
      (error as any).code = 'INVALID_USERNAME';
      throw error;
    }

    await runTransaction(db, async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists()) {
        const error = new Error('PROFILE_NOT_FOUND');
        (error as any).code = 'PROFILE_NOT_FOUND';
        throw error;
      }

      const currentUsername = normalizeUsername(String(userSnap.data()?.username || ''));
      const usernameChanged = nextUsername !== currentUsername;

      if (usernameChanged) {
        const nextUsernameRef = doc(db, 'usernames', nextUsername);
        const nextUsernameSnap = await tx.get(nextUsernameRef);
        const claimedUid = String(nextUsernameSnap.data()?.uid || '');
        if (nextUsernameSnap.exists() && claimedUid && claimedUid !== uid) {
          const error = new Error('USERNAME_TAKEN');
          (error as any).code = 'USERNAME_TAKEN';
          throw error;
        }

        if (currentUsername) {
          const currentUsernameRef = doc(db, 'usernames', currentUsername);
          tx.delete(currentUsernameRef);
        }

        tx.set(
          nextUsernameRef,
          {
            uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }

      tx.update(userRef, {
        ...payloadBase,
        ...(usernameChanged ? { username: nextUsername } : {}),
      });
    });
  }

  async updateLastActive(uid: string) {
    const userRef = doc(db, 'users', uid);
    await updateDoc(userRef, { lastActiveAt: serverTimestamp() });
  }

  async uploadProfilePhoto(uid: string, uri: string) {
    const filename = uri.split('/').pop() || `profile_${Date.now()}.jpg`;
    const storageRef = ref(storage, `profilePics/${uid}/${filename}`);
    const response = await fetch(uri);
    const blob = await response.blob();
    await uploadBytes(storageRef, blob);
    const url = await getDownloadURL(storageRef);
    return { url, path: storageRef.fullPath };
  }
}

export const userProfileService = new UserProfileService();

export async function createUserProfile(input: SignupProfileInput) {
  return userProfileService.createUserProfile(input);
}

export async function updateUserProfile(uid: string, input: ProfileUpdateInput) {
  return userProfileService.updateUserProfile(uid, input);
}

export async function updateLastActive(uid: string) {
  return userProfileService.updateLastActive(uid);
}

export async function uploadProfilePhoto(uid: string, uri: string) {
  return userProfileService.uploadProfilePhoto(uid, uri);
}
