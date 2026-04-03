// src/tryon/types.ts
export type GarmentCategory = 'top' | 'bottom' | 'dress' | 'outerwear';

export type GarmentItem = {
  id: string;
  name: string;
  brand?: string;
  imageUri: string;   // URL or local file URI to the garment render
  maskUri?: string;   // optional segmentation mask if your provider needs it
  category: GarmentCategory;
  size?: string;
};

export type TryOnRequest = {
  selfieUri: string;         // file:// URI from camera or picker
  garmentImageUri: string;   // file:// or https:// (we transcode to local file before upload)
  category: GarmentCategory;
  size?: string;

  /** Optional hints forwarded to the backend (and your local server). */
  personMime?: 'image/jpeg' | 'image/png';   // default: image/jpeg (selfies)
  productMime?: 'image/png'  | 'image/jpeg'; // default: image/png  (garments)

  /** Optional generation knobs (forwarded). */
  baseSteps?: number;
  count?: number;
};

export type TryOnResult = {
  outputUri: string;  // file:// saved to cache so you can display/share
  metadata?: any;
};

export type TryOnProvider = (req: TryOnRequest) => Promise<TryOnResult>;
