export const PRIVACY_POLICY_VERSION = '2026-03-08';
export const PRIVACY_POLICY_LAST_UPDATED = '8 March 2026';

export type PrivacyPolicyPoint = {
  title: string;
  body: string;
};

export type PrivacyPolicyLink = {
  label: string;
  url: string;
};

export const PRIVACY_POLICY_POINTS: PrivacyPolicyPoint[] = [
  {
    title: 'What account data is collected',
    body:
      'Firebase Authentication stores your login details, and Firestore stores the profile details you enter such as username, display name, date of birth, bio, preferences, and any delivery address you choose to save.',
  },
  {
    title: 'Where marketplace and social data is stored',
    body:
      'Published listings, posts, likes, comments, follows, and order records are stored in Firebase Firestore. Photos you publish are stored in Firebase Storage.',
  },
  {
    title: 'What stays only on your device',
    body:
      'Listing drafts, saved try-on outfits, and closet items can be kept in local device storage so they stay private to your device until you publish or remove them.',
  },
  {
    title: 'How payments are handled',
    body:
      'Payments are processed through Stripe. The app stores order references and shipping details needed to complete purchases, but does not store full card numbers or CVC codes in Firebase.',
  },
  {
    title: 'When photos may be processed outside Firebase',
    body:
      'If you use try-on or vision features, the images you submit are sent to the configured processing endpoints so the app can generate matching or try-on results. In this codebase, those input images are not automatically written to Firebase Storage or a Google Cloud Storage bucket, and results are only saved to your device or Firebase if you choose to save or publish them.',
  },
  {
    title: 'How data is used',
    body:
      'Data is used to run accounts, show your content, support recommendations, complete orders, reduce abuse, and keep the marketplace working. The goal is data minimisation: collect what the app genuinely needs, not more.',
  },
];

export const BASIC_TERMS_POINTS: PrivacyPolicyPoint[] = [
  {
    title: '18+ only',
    body: 'You should only create an account if you are 18 or older.',
  },
  {
    title: 'Use the app honestly',
    body:
      'Only upload content you have the right to use, and do not scam, impersonate, or misuse the buying, selling, posting, or try-on features.',
  },
];

export const PRIVACY_POLICY_LINKS: PrivacyPolicyLink[] = [
  {
    label: 'ICO: UK GDPR guidance and resources',
    url: 'https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/',
  },
  {
    label: 'ICO: Right to be informed',
    url: 'https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/right-to-be-informed/',
  },
  {
    label: 'UK legislation: Data Protection Act 2018',
    url: 'https://www.legislation.gov.uk/ukpga/2018/12/contents',
  },
];
