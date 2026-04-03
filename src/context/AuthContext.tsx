import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  EmailAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  deleteUser,
  reauthenticateWithCredential,
  reload,
  updateEmail as firebaseUpdateEmail,
  updatePassword as firebaseUpdatePassword,
  type User,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import {
  createUserProfile,
  updateUserProfile,
  uploadProfilePhoto,
  updateLastActive,
  type SexPreference,
  type UserProfile,
} from '../lib/firebaseUsers';
import type { ShippingAddress } from '../lib/shippingAddress';

export type SignUpInput = {
  email: string;
  password: string;
  username: string;
  displayName: string;
  dateOfBirth: string;
  isAdult: boolean;
  bio?: string;
  photoUri?: string;
  sexPreference?: SexPreference;
  shippingAddress: ShippingAddress;
  legalPolicyVersionAccepted: string;
};

type AuthContextShape = {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (input: {
    username?: string;
    displayName: string;
    bio: string;
    photoURL?: string;
    sexPreference?: SexPreference;
    shippingAddress?: ShippingAddress;
  }) => Promise<void>;
  uploadProfileImage: (uri: string) => Promise<string>;
  updateAccountCredentials: (input: { email?: string; currentPassword: string; newPassword?: string }) => Promise<{ emailChanged: boolean; passwordChanged: boolean }>;
};

const AuthContext = createContext<AuthContextShape>({
  user: null,
  profile: null,
  loading: true,
  signIn: async () => {},
  signUp: async () => {},
  signOut: async () => {},
  updateProfile: async () => {},
  uploadProfileImage: async () => '',
  updateAccountCredentials: async () => ({ emailChanged: false, passwordChanged: false }),
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRevision, setAuthRevision] = useState(0);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    const userRef = doc(db, 'users', user.uid);
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        setProfile((snap.data() as UserProfile) || null);
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setProfile(null);
          return;
        }
        console.warn('[AuthContext] user profile listener error', error);
      }
    );
    void updateLastActive(user.uid).catch(() => {});
    return unsub;
  }, [user?.uid]);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  };

  const signUp = async (input: SignUpInput) => {
    const cred = await createUserWithEmailAndPassword(auth, input.email.trim(), input.password);
    try {
      let photoURL = '';
      if (input.photoUri) {
        const uploaded = await uploadProfilePhoto(cred.user.uid, input.photoUri);
        photoURL = uploaded.url;
      }
      await createUserProfile({
        uid: cred.user.uid,
        username: input.username,
        displayName: input.displayName,
        dateOfBirth: input.dateOfBirth,
        isAdult: input.isAdult,
        bio: input.bio,
        photoURL,
        sexPreference: input.sexPreference,
        shippingAddress: input.shippingAddress,
        legalPolicyVersionAccepted: input.legalPolicyVersionAccepted,
      });
    } catch (err) {
      try {
        await deleteUser(cred.user);
      } catch {
        // ignore cleanup failure
      }
      throw err;
    }
  };

  const signOut = async () => {
    await firebaseSignOut(auth);
  };

  const updateProfile = async (input: {
    username?: string;
    displayName: string;
    bio: string;
    photoURL?: string;
    sexPreference?: SexPreference;
    shippingAddress?: ShippingAddress;
  }) => {
    if (!user) return;
    await updateUserProfile(user.uid, input);
  };

  const uploadProfileImage = async (uri: string) => {
    if (!user) return '';
    const { url } = await uploadProfilePhoto(user.uid, uri);
    return url;
  };

  const updateAccountCredentials = async (input: { email?: string; currentPassword: string; newPassword?: string }) => {
    if (!user) return { emailChanged: false, passwordChanged: false };

    const currentEmail = user.email?.trim() || '';
    const nextEmail = input.email?.trim() || '';
    const nextPassword = input.newPassword || '';
    const emailChanged = !!nextEmail && nextEmail !== currentEmail;
    const passwordChanged = nextPassword.length > 0;

    if (!emailChanged && !passwordChanged) {
      return { emailChanged: false, passwordChanged: false };
    }

    if (!currentEmail) {
      const error = new Error('NO_EMAIL_PROVIDER');
      (error as any).code = 'auth/no-email-provider';
      throw error;
    }

    if (!input.currentPassword) {
      const error = new Error('CURRENT_PASSWORD_REQUIRED');
      (error as any).code = 'auth/missing-password';
      throw error;
    }

    const credential = EmailAuthProvider.credential(currentEmail, input.currentPassword);
    await reauthenticateWithCredential(user, credential);

    const result = { emailChanged: false, passwordChanged: false };

    try {
      if (emailChanged) {
        await firebaseUpdateEmail(user, nextEmail);
        result.emailChanged = true;
      }

      if (passwordChanged) {
        await firebaseUpdatePassword(user, nextPassword);
        result.passwordChanged = true;
      }

      await reload(user);
      setAuthRevision((value) => value + 1);

      return result;
    } catch (error: any) {
      if (result.emailChanged || result.passwordChanged) {
        await reload(user).catch(() => {});
        setAuthRevision((value) => value + 1);
      }
      const nextError = error instanceof Error ? error : new Error('UPDATE_ACCOUNT_FAILED');
      (nextError as any).partial = result;
      throw nextError;
    }
  };

  const value = useMemo(
    () => ({
      user,
      profile,
      loading,
      signIn,
      signUp,
      signOut,
      updateProfile,
      uploadProfileImage,
      updateAccountCredentials,
    }),
    [user, profile, loading, authRevision]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
