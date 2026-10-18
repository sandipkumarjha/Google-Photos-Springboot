import { API_URL, getValidAccessToken, type Photo } from "@/lib/api";

/** Mirrors the MIME types the backend's PhotoService accepts. */
export const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
] as const;

export const ACCEPTED_IMAGE_EXTENSIONS = ".jpg,.jpeg,.png,.webp,.gif,.heic,.heif";

/**
 * Client-side sanity cap. The backend (Spring multipart) enforces its own
 * limit and returns a descriptive error, which the UI surfaces as-is.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type UploadValidation =
  | { ok: true; file: File }
  | { ok: false; file: File; reason: string };

export function validateUploadFile(file: File): UploadValidation {
  const isAcceptedType =
    (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type) ||
    // Some browsers report HEIC/HEIF files without a MIME type.
    (file.type === "" && /\.(heic|heif)$/i.test(file.name));

  if (!isAcceptedType) {
    return { ok: false, file, reason: "Unsupported format. Use JPEG, PNG, WebP, GIF, or HEIC." };
  }
  if (file.size === 0) {
    return { ok: false, file, reason: "The file is empty." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, file, reason: "Larger than 50 MB." };
  }
  return { ok: true, file };
}

function parseUploadError(status: number, responseText: string): string {
  if (status === 413) {
    return "The file is larger than the server allows.";
  }

  if (!responseText) {
    return `Upload failed (${status})`;
  }

  try {
    const body = JSON.parse(responseText) as {
      message?: string;
      detail?: string;
      error?: string;
      title?: string;
    };

    return (
      body.message ??
      body.detail ??
      body.error ??
      body.title ??
      `Upload failed (${status})`
    );
  } catch {
    const trimmed = responseText.trim();
    return trimmed.length > 0 && trimmed.length < 200
      ? trimmed
      : `Upload failed (${status})`;
  }
}

export async function uploadPhotoFile(
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Photo> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error("Not authenticated");
  }

  const formData = new FormData();
  formData.append("file", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/photos/upload`);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);

    const abort = () => {
      xhr.abort();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as Photo);
        } catch {
          reject(new Error("Invalid response from server"));
        }
        return;
      }

      reject(new Error(parseUploadError(xhr.status, xhr.responseText)));
    };

    xhr.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("Network error during upload"));
    };
    xhr.send(formData);
  });
}
