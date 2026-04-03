import React, { createContext, useContext } from 'react';
import type { UploadEditorRequest } from '../lib/listingEditor';
import type { TabKey } from '../components/Dock';

export type ProfileScreenRequest = {
  requestId: string;
  tab?: 'listings' | 'closet' | 'outfits' | 'posts' | 'likes' | 'orders';
  openAddCloset?: boolean;
};

type NavContextShape = {
  navigate: (route: { name: string; params?: any }) => void | Promise<void>;
  goToTryOn?: () => void | Promise<void>;
  goToTab?: (tab: TabKey) => void | Promise<void>;
  openUploadEditor?: (request: Omit<UploadEditorRequest, 'requestId'>) => void | Promise<void>;
  openProfileClosetAdd?: () => void | Promise<void>;
  leaveUpload?: () => void | Promise<void>;
};

const NavContext = createContext<NavContextShape>({
  navigate: () => {},
  goToTryOn: () => {},
  goToTab: () => {},
  openUploadEditor: () => {},
  openProfileClosetAdd: () => {},
  leaveUpload: () => {},
});

export const useNav = () => useContext(NavContext);

export default NavContext;
