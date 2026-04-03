const { onDocumentCreated, onDocumentDeleted, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

async function applyFollowDelta({ targetUid, sourceUid, delta }) {
  const targetRef = db.doc(`users/${targetUid}`);
  const sourceRef = db.doc(`users/${sourceUid}`);

  await db.runTransaction(async (tx) => {
    const targetSnap = await tx.get(targetRef);
    const sourceSnap = await tx.get(sourceRef);

    if (!targetSnap.exists || !sourceSnap.exists) return;

    const targetCount = Math.max(
      0,
      Number(targetSnap.data()?.followersCount ?? 0) + delta
    );
    const sourceCount = Math.max(
      0,
      Number(sourceSnap.data()?.followingCount ?? 0) + delta
    );

    tx.update(targetRef, { followersCount: targetCount });
    tx.update(sourceRef, { followingCount: sourceCount });
  });
}

async function syncSubcollectionCount({ parentPath, subcollection, field, context }) {
  const parentRef = db.doc(parentPath);
  const parentSnap = await parentRef.get();
  if (!parentSnap.exists) return;

  const countSnap = await parentRef.collection(subcollection).count().get();
  const count = Number(countSnap.data()?.count ?? 0);
  await parentRef.update({ [field]: Math.max(0, count) });

  logger.debug('count synced', {
    parentPath,
    subcollection,
    field,
    count,
    context,
  });
}

exports.followersOnCreate = onDocumentCreated(
  'users/{targetUid}/followers/{sourceUid}',
  async (event) => {
    const targetUid = event.params.targetUid;
    const sourceUid = event.params.sourceUid;
    if (!targetUid || !sourceUid) return;
    try {
      await applyFollowDelta({ targetUid, sourceUid, delta: 1 });
    } catch (err) {
      logger.error('followersOnCreate failed', { targetUid, sourceUid, err });
    }
  }
);

exports.followersOnDelete = onDocumentDeleted(
  'users/{targetUid}/followers/{sourceUid}',
  async (event) => {
    const targetUid = event.params.targetUid;
    const sourceUid = event.params.sourceUid;
    if (!targetUid || !sourceUid) return;
    try {
      await applyFollowDelta({ targetUid, sourceUid, delta: -1 });
    } catch (err) {
      logger.error('followersOnDelete failed', { targetUid, sourceUid, err });
    }
  }
);

exports.postLikerCreated = onDocumentCreated(
  'posts/{postId}/likers/{uid}',
  async (event) => {
    const postId = event.params.postId;
    if (!postId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}`,
        subcollection: 'likers',
        field: 'likeCount',
        context: 'post-like-create',
      });
    } catch (err) {
      logger.error('postLikerCreated failed', { postId, err });
    }
  }
);

exports.postLikerDeleted = onDocumentDeleted(
  'posts/{postId}/likers/{uid}',
  async (event) => {
    const postId = event.params.postId;
    if (!postId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}`,
        subcollection: 'likers',
        field: 'likeCount',
        context: 'post-like-delete',
      });
    } catch (err) {
      logger.error('postLikerDeleted failed', { postId, err });
    }
  }
);

exports.postCommentCreated = onDocumentCreated(
  'posts/{postId}/comments/{commentId}',
  async (event) => {
    const postId = event.params.postId;
    if (!postId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}`,
        subcollection: 'comments',
        field: 'commentCount',
        context: 'post-comment-create',
      });
    } catch (err) {
      logger.error('postCommentCreated failed', { postId, err });
    }
  }
);

exports.postCommentDeleted = onDocumentDeleted(
  'posts/{postId}/comments/{commentId}',
  async (event) => {
    const postId = event.params.postId;
    if (!postId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}`,
        subcollection: 'comments',
        field: 'commentCount',
        context: 'post-comment-delete',
      });
    } catch (err) {
      logger.error('postCommentDeleted failed', { postId, err });
    }
  }
);

exports.commentLikerCreated = onDocumentCreated(
  'posts/{postId}/comments/{commentId}/likers/{uid}',
  async (event) => {
    const postId = event.params.postId;
    const commentId = event.params.commentId;
    if (!postId || !commentId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}/comments/${commentId}`,
        subcollection: 'likers',
        field: 'likeCount',
        context: 'comment-like-create',
      });
    } catch (err) {
      logger.error('commentLikerCreated failed', { postId, commentId, err });
    }
  }
);

exports.commentLikerDeleted = onDocumentDeleted(
  'posts/{postId}/comments/{commentId}/likers/{uid}',
  async (event) => {
    const postId = event.params.postId;
    const commentId = event.params.commentId;
    if (!postId || !commentId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}/comments/${commentId}`,
        subcollection: 'likers',
        field: 'likeCount',
        context: 'comment-like-delete',
      });
    } catch (err) {
      logger.error('commentLikerDeleted failed', { postId, commentId, err });
    }
  }
);

exports.replyCreated = onDocumentCreated(
  'posts/{postId}/comments/{commentId}/replies/{replyId}',
  async (event) => {
    const postId = event.params.postId;
    const commentId = event.params.commentId;
    if (!postId || !commentId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}/comments/${commentId}`,
        subcollection: 'replies',
        field: 'replyCount',
        context: 'reply-create',
      });
    } catch (err) {
      logger.error('replyCreated failed', { postId, commentId, err });
    }
  }
);

exports.replyDeleted = onDocumentDeleted(
  'posts/{postId}/comments/{commentId}/replies/{replyId}',
  async (event) => {
    const postId = event.params.postId;
    const commentId = event.params.commentId;
    if (!postId || !commentId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}/comments/${commentId}`,
        subcollection: 'replies',
        field: 'replyCount',
        context: 'reply-delete',
      });
    } catch (err) {
      logger.error('replyDeleted failed', { postId, commentId, err });
    }
  }
);

exports.replyLikerCreated = onDocumentCreated(
  'posts/{postId}/comments/{commentId}/replies/{replyId}/likers/{uid}',
  async (event) => {
    const postId = event.params.postId;
    const commentId = event.params.commentId;
    const replyId = event.params.replyId;
    if (!postId || !commentId || !replyId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}/comments/${commentId}/replies/${replyId}`,
        subcollection: 'likers',
        field: 'likeCount',
        context: 'reply-like-create',
      });
    } catch (err) {
      logger.error('replyLikerCreated failed', { postId, commentId, replyId, err });
    }
  }
);

exports.replyLikerDeleted = onDocumentDeleted(
  'posts/{postId}/comments/{commentId}/replies/{replyId}/likers/{uid}',
  async (event) => {
    const postId = event.params.postId;
    const commentId = event.params.commentId;
    const replyId = event.params.replyId;
    if (!postId || !commentId || !replyId) return;
    try {
      await syncSubcollectionCount({
        parentPath: `posts/${postId}/comments/${commentId}/replies/${replyId}`,
        subcollection: 'likers',
        field: 'likeCount',
        context: 'reply-like-delete',
      });
    } catch (err) {
      logger.error('replyLikerDeleted failed', { postId, commentId, replyId, err });
    }
  }
);

const LISTING_REINDEX_FIELDS = [
  'photos',
  'title',
  'description',
  'brand',
  'category',
  'colors',
  'tags',
  'gender',
  'status',
];

const SERVER_RECOMMENDATION_FIELDS = new Set([
  'recommendationIndexedAt',
  'recommendationMutationId',
  'embeddingContentHash',
  'embeddingModel',
  'role',
  'vibes',
  'fit',
  'sub',
  'occasionTags',
  'styleMarkers',
  'formalityScore',
  'streetwearScore',
  'cleanlinessScore',
  'classifierConfidence',
  'entities',
  'entityMeta',
  'sportMeta',
]);

function stableSerialize(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function fieldChanged(before, after, field) {
  return stableSerialize(before?.[field]) !== stableSerialize(after?.[field]);
}

function listingNeedsReindex(before, after) {
  if (!after) return false;
  return LISTING_REINDEX_FIELDS.some((field) => fieldChanged(before, after, field));
}

function isRecommendationMutationOnly(before, after) {
  const nextMutationId = String(after?.recommendationMutationId || '').trim();
  if (!nextMutationId) return false;
  const prevMutationId = String(before?.recommendationMutationId || '').trim();
  if (prevMutationId === nextMutationId) return false;

  const changedFields = Object.keys(after || {}).filter((field) => fieldChanged(before, after, field));
  return changedFields.length > 0 && changedFields.every((field) => SERVER_RECOMMENDATION_FIELDS.has(field));
}

async function callRecommendationIngest(pathname, payload) {
  const baseUrl = String(
    process.env.RECOMMENDER_INGEST_BASE_URL ||
      process.env.TRYON_API_BASE_URL ||
      process.env.RECOMMENDER_BASE_URL ||
      '',
  ).trim().replace(/\/+$/, '');
  const ingestApiKey = String(process.env.INGEST_API_KEY || '').trim();
  const publicApiKey = String(process.env.API_KEY || '').trim();

  if (!baseUrl || !ingestApiKey) {
    logger.warn('Recommendation ingest is not configured', {
      hasBaseUrl: Boolean(baseUrl),
      hasApiKey: Boolean(ingestApiKey),
      pathname,
    });
    return;
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ingest-api-key': ingestApiKey,
      ...(publicApiKey ? { 'x-api-key': publicApiKey } : {}),
    },
    body: JSON.stringify(payload || {}),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Ingest request failed (${response.status})`);
  }
  return text;
}

exports.listingRecommendationCreated = onDocumentCreated(
  'listings/{listingId}',
  async (event) => {
    const listingId = event.params.listingId;
    const after = event.data?.data();
    if (!listingId || !after) return;
    if (!listingNeedsReindex(null, after)) return;
    try {
      await callRecommendationIngest('/internal/recommendations/reindex-listing', { listingId });
    } catch (err) {
      logger.error('listingRecommendationCreated failed', { listingId, err });
    }
  }
);

exports.listingRecommendationUpdated = onDocumentUpdated(
  'listings/{listingId}',
  async (event) => {
    const listingId = event.params.listingId;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!listingId || !after) return;
    if (isRecommendationMutationOnly(before, after)) return;
    if (!listingNeedsReindex(before, after)) return;
    try {
      await callRecommendationIngest('/internal/recommendations/reindex-listing', { listingId });
    } catch (err) {
      logger.error('listingRecommendationUpdated failed', { listingId, err });
    }
  }
);
