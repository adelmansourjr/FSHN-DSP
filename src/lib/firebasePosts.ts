import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { uploadImageToStorage, deriveImageExt } from './storageUploads';

export type PostGarmentInput = {
  role?: string | null;
  title?: string | null;
  listingId?: string | null;
  itemId?: string | null;
  image?: string | null;
  imagePath?: string | null;
  brand?: string | null;
  category?: string | null;
  price?: string | null;
  size?: string | null;
  condition?: string | null;
  tags?: string[] | null;
};

type CreatePostInput = {
  authorUid: string;
  imageUri: string;
  caption?: string;
  authorUsername?: string | null;
  authorPhotoURL?: string | null;
  garments?: PostGarmentInput[];
};

const clean = (value?: string | null, max = 240) => {
  const out = String(value || '').trim();
  return out ? out.slice(0, max) : '';
};

const firstNonEmpty = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    const next = clean(value);
    if (next) return next;
  }
  return '';
};

export class PostGarmentRecord {
  role: string;
  title: string;
  listingId: string;
  itemId: string;
  image: string;
  imagePath: string;
  brand: string;
  category: string;
  price: string;
  size: string;
  condition: string;
  tags: string[];

  constructor(input?: PostGarmentInput) {
    const item = input || {};
    this.role = firstNonEmpty(item?.role, (item as any)?.slot, (item as any)?.type).slice(0, 40);
    this.title =
      firstNonEmpty(item?.title, (item as any)?.name, (item as any)?.label).slice(0, 140) ||
      (this.role ? this.role.slice(0, 140) : '');
    this.listingId = firstNonEmpty(item?.listingId, (item as any)?.listingDocId).slice(0, 120);
    this.itemId = firstNonEmpty(item?.itemId, (item as any)?.id, (item as any)?.productId).slice(0, 120);
    this.image = firstNonEmpty(
      item?.image,
      (item as any)?.imageUrl,
      (item as any)?.imageURL,
      (item as any)?.photoURL,
      (item as any)?.thumbnail
    ).slice(0, 2000);
    this.imagePath = firstNonEmpty(item?.imagePath, (item as any)?.path, (item as any)?.storagePath).slice(0, 512);
    this.brand = firstNonEmpty(item?.brand, (item as any)?.vendor).slice(0, 80);
    this.category = firstNonEmpty(item?.category, (item as any)?.categoryName).slice(0, 80);
    this.price = firstNonEmpty(item?.price, (item as any)?.amount).slice(0, 40);
    this.size = clean(item?.size, 40);
    this.condition = clean(item?.condition, 40);
    this.tags = Array.isArray(item?.tags)
      ? item.tags.map((t) => clean(t, 40)).filter(Boolean).slice(0, 16)
      : [];
  }

  get isEmpty() {
    return !this.image && !this.title && !this.role && !this.listingId && !this.itemId;
  }

  toFirestore() {
    return {
      role: this.role,
      title: this.title,
      listingId: this.listingId,
      itemId: this.itemId,
      image: this.image,
      imagePath: this.imagePath,
      brand: this.brand,
      category: this.category,
      price: this.price,
      size: this.size,
      condition: this.condition,
      tags: this.tags,
    };
  }

  static sanitizeAll(garments?: PostGarmentInput[]) {
    if (!Array.isArray(garments)) return [] as Array<ReturnType<PostGarmentRecord['toFirestore']>>;
    return garments
      .map((item) => new PostGarmentRecord(item))
      .filter((item) => !item.isEmpty)
      .map((item) => item.toFirestore());
  }
}

export class FeedPostRecord {
  authorUid: string;
  authorUsername: string;
  authorPhotoURL: string;
  caption: string;
  imageUrl: string;
  imagePath: string;
  garments: Array<ReturnType<PostGarmentRecord['toFirestore']>>;

  constructor(input: {
    authorUid: string;
    authorUsername?: string | null;
    authorPhotoURL?: string | null;
    caption?: string | null;
    imageUrl: string;
    imagePath: string;
    garments?: PostGarmentInput[];
  }) {
    this.authorUid = input.authorUid;
    this.authorUsername = input.authorUsername ?? '';
    this.authorPhotoURL = input.authorPhotoURL ?? '';
    this.caption = String(input.caption ?? '').trim();
    this.imageUrl = input.imageUrl;
    this.imagePath = input.imagePath;
    this.garments = PostGarmentRecord.sanitizeAll(input.garments);
  }

  toFirestore() {
    return {
      authorUid: this.authorUid,
      authorUsername: this.authorUsername,
      authorPhotoURL: this.authorPhotoURL,
      createdAt: serverTimestamp(),
      caption: this.caption,
      imageUrl: this.imageUrl,
      image: { url: this.imageUrl, path: this.imagePath },
      images: [{ url: this.imageUrl, path: this.imagePath }],
      likeCount: 0,
      commentCount: 0,
      state: 'ok',
      removedAt: null,
      removedReason: null,
      source: 'tryon',
      garments: this.garments,
    };
  }
}

export class FeedPostService {
  async createPostFromImage(input: CreatePostInput) {
    const postsRef = collection(db, 'posts');
    const postRef = doc(postsRef);
    const ext = deriveImageExt(input.imageUri);
    const upload = await uploadImageToStorage(`posts/${input.authorUid}/${postRef.id}.${ext}`, input.imageUri);
    const post = new FeedPostRecord({
      authorUid: input.authorUid,
      authorUsername: input.authorUsername,
      authorPhotoURL: input.authorPhotoURL,
      caption: input.caption ?? '',
      imageUrl: upload.url,
      imagePath: upload.path,
      garments: input.garments,
    });

    await setDoc(postRef, post.toFirestore());

    if (__DEV__) {
      console.log('[createPostFromImage] post created', {
        id: postRef.id,
        authorUid: input.authorUid,
        image: upload.url,
      });
    }

    return { id: postRef.id, image: upload.url };
  }
}

export const feedPostService = new FeedPostService();

export async function createPostFromImage(input: CreatePostInput) {
  return feedPostService.createPostFromImage(input);
}
