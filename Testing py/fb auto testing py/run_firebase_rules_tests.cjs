const fs = require('node:fs');
const path = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
const {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} = require('firebase/firestore');
const {
  getMetadata,
  ref,
  uploadString,
} = require('firebase/storage');

const SUITE_DIR = __dirname;
const RESULTS_PATH = path.join(SUITE_DIR, 'firebase_rules_results.json');
const REPORT_PATH = path.join(SUITE_DIR, 'firebase_rules_report.md');
const PROJECT_ID = 'demo-fshn-rules';
const FIRESTORE_RULES_PATH = path.join(SUITE_DIR, 'firestore.rules');
const STORAGE_RULES_PATH = path.join(SUITE_DIR, 'storage.rules');
const FIRESTORE_RULES = fs.readFileSync(FIRESTORE_RULES_PATH, 'utf8');
const STORAGE_RULES = fs.readFileSync(STORAGE_RULES_PATH, 'utf8');

function parseHostPort(value, fallbackHost, fallbackPort) {
  const raw = String(value || '').trim();
  if (!raw) {
    return { host: fallbackHost, port: fallbackPort };
  }
  const [host, port] = raw.split(':');
  return {
    host: host || fallbackHost,
    port: Number(port || fallbackPort),
  };
}

const firestoreEndpoint = parseHostPort(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1', 8088);
const storageEndpoint = parseHostPort(process.env.FIREBASE_STORAGE_EMULATOR_HOST, '127.0.0.1', 9198);

const NOW = new Date('2026-03-11T00:00:00.000Z');

function makeUserDoc(uid, overrides = {}) {
  return {
    username: uid,
    displayName: uid.toUpperCase(),
    dateOfBirth: '1990-01-01',
    isAdult: true,
    createdAt: NOW,
    lastActiveAt: NOW,
    followersCount: 0,
    followingCount: 0,
    postsCount: 0,
    listingsCount: 0,
    tryOnCount: 0,
    status: 'active',
    strikesCount: 0,
    photoURL: '',
    bio: '',
    ...overrides,
  };
}

function makeListingDoc(sellerUid, overrides = {}) {
  return {
    sellerUid,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'active',
    title: 'Vintage jacket',
    description: 'Seed listing',
    price: {
      amount: 5000,
      currency: 'GBP',
    },
    primeImage: {
      url: 'https://example.com/listing.jpg',
      path: 'listings/listing-1/listing.jpg',
    },
    photos: [
      {
        url: 'https://example.com/listing.jpg',
        path: 'listings/listing-1/listing.jpg',
      },
    ],
    brand: 'Brand',
    category: 'outerwear',
    size: 'M',
    condition: 'good',
    role: '',
    vibes: [],
    colors: ['black'],
    pattern: '',
    season: '',
    material: '',
    gender: '',
    fit: '',
    measurements: {},
    sku: '',
    source: 'app',
    tags: ['outerwear'],
    state: 'ok',
    removedAt: null,
    removedReason: null,
    likeCount: 0,
    viewCount: 0,
    ...overrides,
  };
}

function makeOrderDoc(overrides = {}) {
  return {
    buyerUid: 'buyer',
    sellerUid: 'seller',
    listingId: 'listing-1',
    status: 'paid',
    updatedAt: NOW,
    shippedAt: null,
    outForDeliveryAt: null,
    deliveredAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelledByUid: null,
    ...overrides,
  };
}

function makeUserCreatePayload(uid) {
  return {
    username: uid,
    displayName: uid.toUpperCase(),
    dateOfBirth: '1995-02-02',
    isAdult: true,
    createdAt: serverTimestamp(),
    lastActiveAt: serverTimestamp(),
    followersCount: 0,
    followingCount: 0,
    postsCount: 0,
    listingsCount: 0,
    tryOnCount: 0,
    status: 'active',
    strikesCount: 0,
    photoURL: '',
    bio: '',
  };
}

function summarizeError(error) {
  if (!error) return '';
  return String(error.message || error).split('\n').slice(0, 4).join(' | ');
}

function formatStatus(status) {
  return status === 'PASS' ? 'Checked and working' : 'Failed';
}

function markdownTable(headers, rows) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: firestoreEndpoint.host,
      port: firestoreEndpoint.port,
      rules: FIRESTORE_RULES,
    },
    storage: {
      host: storageEndpoint.host,
      port: storageEndpoint.port,
      rules: STORAGE_RULES,
    },
  });

  const results = [];

  function authedDb(uid, claims = { admin: false }) {
    return testEnv.authenticatedContext(uid, claims).firestore();
  }

  function authedStorage(uid, claims = { admin: false }) {
    return testEnv.authenticatedContext(uid, claims).storage();
  }

  async function seed(fn) {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(fn);
  }

  async function runCheck(checkId, name, fn) {
    try {
      await fn();
      results.push({
        check_id: checkId,
        name,
        status: 'PASS',
        summary: name,
        details: '',
      });
      console.log(`PASS ${checkId} ${name}`);
    } catch (error) {
      results.push({
        check_id: checkId,
        name,
        status: 'FAIL',
        summary: name,
        details: summarizeError(error),
      });
      console.log(`FAIL ${checkId} ${name}`);
      console.error(error);
    }
  }

  try {
    await runCheck('unauthenticated_user_write_denied', 'Unauthenticated clients cannot create user profiles', async () => {
      const db = testEnv.unauthenticatedContext().firestore();
      await assertFails(setDoc(doc(db, 'users', 'anon'), makeUserCreatePayload('anon')));
    });

    await runCheck('unauthenticated_profile_pic_upload_denied', 'Unauthenticated clients cannot upload profile pictures', async () => {
      const storage = testEnv.unauthenticatedContext().storage();
      await assertFails(uploadString(ref(storage, 'profilePics/anon/avatar.txt'), 'avatar'));
    });

    await runCheck('immutable_date_of_birth_update_denied', 'Users cannot change date of birth after profile creation', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'alice'), makeUserDoc('alice'));
      });
      const db = authedDb('alice');
      await assertFails(updateDoc(doc(db, 'users', 'alice'), { dateOfBirth: '1991-02-02' }));
    });

    await runCheck('immutable_username_update_denied', 'Users cannot change username through direct profile writes', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'alice'), makeUserDoc('alice'));
      });
      const db = authedDb('alice');
      await assertFails(updateDoc(doc(db, 'users', 'alice'), { username: 'alice2' }));
    });

    await runCheck('counterfeit_followers_count_denied', 'Counterfeit followersCount updates are rejected', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'alice'), makeUserDoc('alice'));
        await setDoc(doc(db, 'users', 'bob'), makeUserDoc('bob'));
      });
      const db = authedDb('bob');
      await assertFails(updateDoc(doc(db, 'users', 'alice'), { followersCount: 999 }));
    });

    await runCheck('counterfeit_listing_like_count_denied', 'Counterfeit listing likeCount updates are rejected', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'seller'), makeUserDoc('seller'));
        await setDoc(doc(db, 'users', 'bob'), makeUserDoc('bob'));
        await setDoc(doc(db, 'listings', 'listing-1'), makeListingDoc('seller'));
      });
      const db = authedDb('bob');
      await assertFails(updateDoc(doc(db, 'listings', 'listing-1'), { likeCount: 12 }));
    });

    await runCheck('batched_followers_increment_allowed', 'Valid batched follow edge writes can increment followersCount', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'alice'), makeUserDoc('alice'));
        await setDoc(doc(db, 'users', 'bob'), makeUserDoc('bob'));
      });
      const db = authedDb('bob');
      const batch = writeBatch(db);
      batch.set(doc(db, 'users', 'bob', 'following', 'alice'), { createdAt: serverTimestamp() });
      batch.update(doc(db, 'users', 'alice'), { followersCount: 1 });
      await assertSucceeds(batch.commit());
    });

    await runCheck('batched_listing_like_increment_allowed', 'Valid batched liker edge writes can increment listing likeCount', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'seller'), makeUserDoc('seller'));
        await setDoc(doc(db, 'users', 'bob'), makeUserDoc('bob'));
        await setDoc(doc(db, 'listings', 'listing-1'), makeListingDoc('seller'));
      });
      const db = authedDb('bob');
      const batch = writeBatch(db);
      batch.set(doc(db, 'listings', 'listing-1', 'likers', 'bob'), { createdAt: serverTimestamp() });
      batch.update(doc(db, 'listings', 'listing-1'), { likeCount: 1 });
      await assertSucceeds(batch.commit());
    });

    await runCheck('listing_soft_remove_denied', 'Seller clients cannot write moderation removal fields on listings', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'seller'), makeUserDoc('seller'));
        await setDoc(doc(db, 'listings', 'listing-1'), makeListingDoc('seller'));
      });
      const db = authedDb('seller');
      await assertFails(updateDoc(doc(db, 'listings', 'listing-1'), {
        status: 'removed',
        state: 'removed',
        removedAt: serverTimestamp(),
        removedReason: 'seller_removed',
        updatedAt: serverTimestamp(),
      }));
    });

    await runCheck('blocked_profile_read_denied', 'Blocked users cannot read each other’s profile documents', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'alice'), makeUserDoc('alice'));
        await setDoc(doc(db, 'users', 'bob'), makeUserDoc('bob'));
        await setDoc(doc(db, 'users', 'alice', 'blocked', 'bob'), { createdAt: NOW, reason: 'safety' });
      });
      const db = authedDb('bob');
      await assertFails(getDoc(doc(db, 'users', 'alice')));
    });

    await runCheck('blocked_profile_picture_read_denied', 'Blocked users cannot read blocked profile pictures from Storage', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users', 'alice'), makeUserDoc('alice'));
        await setDoc(doc(db, 'users', 'bob'), makeUserDoc('bob'));
        await setDoc(doc(db, 'users', 'alice', 'blocked', 'bob'), { createdAt: NOW, reason: 'safety' });
        const storage = context.storage();
        await uploadString(ref(storage, 'profilePics/alice/avatar.txt'), 'avatar');
      });
      const storage = authedStorage('bob');
      await assertFails(getMetadata(ref(storage, 'profilePics/alice/avatar.txt')));
    });

    await runCheck('stripe_customer_write_denied', 'Clients cannot write Stripe customer state documents', async () => {
      await seed(async () => {});
      const db = authedDb('buyer');
      await assertFails(setDoc(doc(db, 'stripeCustomers', 'buyer'), { provider: 'stripe' }));
    });

    await runCheck('checkout_session_write_denied', 'Clients cannot create checkout session documents directly', async () => {
      await seed(async () => {});
      const db = authedDb('buyer');
      await assertFails(setDoc(doc(db, 'checkoutSessions', 'session-1'), { uid: 'buyer' }));
    });

    await runCheck('order_create_denied', 'Clients cannot create order documents directly', async () => {
      await seed(async () => {});
      const db = authedDb('buyer');
      await assertFails(setDoc(doc(db, 'orders', 'order-1'), makeOrderDoc()));
    });

    await runCheck('buyer_cannot_mark_order_shipped', 'Buyers cannot forge seller-only shipment state transitions', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'orders', 'order-1'), makeOrderDoc());
      });
      const db = authedDb('buyer');
      await assertFails(updateDoc(doc(db, 'orders', 'order-1'), {
        status: 'shipped',
        updatedAt: serverTimestamp(),
        shippedAt: serverTimestamp(),
      }));
    });

    await runCheck('seller_can_mark_order_shipped', 'Sellers can perform the allowed paid-to-shipped transition', async () => {
      await seed(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'orders', 'order-1'), makeOrderDoc());
      });
      const db = authedDb('seller');
      await assertSucceeds(updateDoc(doc(db, 'orders', 'order-1'), {
        status: 'shipped',
        updatedAt: serverTimestamp(),
        shippedAt: serverTimestamp(),
      }));
    });
  } finally {
    await testEnv.cleanup();
  }

  const failed = results.filter((result) => result.status !== 'PASS');
  const generatedAt = new Date().toISOString();
  const report = [
    '# Firebase Rules Test Report',
    '',
    `Generated: ${generatedAt}`,
    '',
    `Summary: total=${results.length}; passed=${results.length - failed.length}; failed=${failed.length}`,
    '',
    markdownTable(
      ['Check', 'Result', 'Notes'],
      results.map((result) => [result.name, formatStatus(result.status), result.details || ''])
    ),
    '',
  ].join('\n');

  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify({
    generated_at: generatedAt,
    checks: results,
  }, null, 2)}\n`);
  fs.writeFileSync(REPORT_PATH, `${report}\n`);

  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
