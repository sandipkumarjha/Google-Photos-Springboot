
import { useAlbumLockStore } from "@/stores/album-lock-store";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Every backend controller is mapped under `/api`. NEXT_PUBLIC_API_URL may be
 * the backend origin (`https://host`) or already include the prefix
 * (`https://host/api`); both resolve to the same base, so paths below never
 * repeat `/api`.
 */
const BACKEND_ORIGIN = (
  process.env.NEXT_PUBLIC_API_URL ??
  "https://google-photos-springboot.onrender.com"
)
  .trim()
  .replace(/\/+$/, "")
  .replace(/\/api$/, "");

export const API_URL = `${BACKEND_ORIGIN}/api`;

export type User = {
  id: string;
  email: string;
  displayName: string;
};

export type AuthResponse = {
  accessToken: string;
  refreshToken: string;
  user: User;
};

type AuthResponsePayload = {
  access_token: string;
  refresh_token: string;
  user: User;
};

function normalizeAuthResponse(
  payload: AuthResponsePayload,
): AuthResponse {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    user: payload.user,
  };
}

export type PhotoStatus = "ACTIVE" | "ARCHIVE" | "TRASH";

export type AiTransformType =
  | "REMOVE_BACKGROUND"
  | "BACKGROUND_AND_SHADOW"
  | "CHANGE_BACKGROUND"
  | "GENERATIVE_FILL"
  | "SMART_CROP"
  | "OBJECT_CROP"
  | "RETOUCH"
  | "UPSCALE"
  | "AI_EDIT";

export type Photo = {
  id: string;
  imagekitFileId: string;
  fileName: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  status: PhotoStatus;
  createdAt: string;
  deletedAt: string | null;
  parentPhotoId: string | null;
  aiTransformType: AiTransformType | null;
  /** ImageKit transformation chain that produced this photo from its parent. */
  editChain: string | null;
};

/** Operations accepted by the edit pipeline; mirrors the backend EditOp enum. */
export type EditOp =
  | "CROP"
  | "ASPECT_CROP"
  | "RESIZE"
  | "ROTATE"
  | "FLIP"
  | "GRAYSCALE"
  | "BLUR"
  | "SHARPEN"
  | "CONTRAST"
  | "RADIUS"
  | "ROUND"
  | "BORDER"
  | "OPACITY"
  | "TRIM"
  | AiTransformType;

export type EditStep = {
  op: EditOp;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  focus?: string;
  fit?: string;
  rotation?: number;
  direction?: string;
  amount?: number;
  color?: string;
  prompt?: string;
  focusObject?: string;
};

export type EditOutput = {
  format?: string;
  quality?: number;
};

export type EditRequest = {
  steps: EditStep[];
  output?: EditOutput;
};

export type EditPreviewResponse = {
  previewUrl: string;
  downloadUrl: string;
  transformChain: string;
  usesAi: boolean;
};

export type PhotoVersions = {
  parent: Photo | null;
  derived: Photo[];
};

export type PhotoSort = "newest" | "oldest" | "name" | "largest";

export type PhotoListParams = {
  status?: PhotoStatus;
  page?: number;
  size?: number;
  q?: string;
  sort?: PhotoSort;
};

export type AiTransformRequest = {
  type: AiTransformType;
  prompt?: string;
  width?: number;
  height?: number;
  focusObject?: string;
};

export type AiTransformPreviewResponse = {
  previewUrl: string;
  type: AiTransformType;
  transformChain: string;
};

export type StorageUsageResponse = {
  libraryUsedBytes: number;
  libraryPhotoCount: number;
  imagekitBandwidthBytes: number | null;
  imagekitStorageBytes: number | null;
};

export type ImageKitAsset = {
  fileId: string;
  fileName: string;
  url: string;
  thumbnailUrl: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  alreadyImported: boolean;
};

export type Album = {
  id: string;
  title: string;
  coverPhotoId: string | null;
  coverThumbnailUrl: string | null;
  photoCount: number;
  /** Protected by a PIN. Cover and photos are withheld until unlocked. */
  locked: boolean;
  /** This response was served with a valid unlock token, so contents are visible. */
  unlocked: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AlbumUnlockResponse = {
  albumToken: string;
  expiresAt: string;
};

export type UpdateAlbumRequest = {
  title?: string;
  coverPhotoId?: string;
};

export type PageResponse<T> = {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
};

export class ApiError extends Error {
  status: number;
  /** Set on 423 Locked: the PIN-protected album that owns the resource. */
  albumId: string | null;

  constructor(
    message: string,
    status: number,
    albumId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.albumId = albumId;
  }
}

export const HTTP_LOCKED = 423;

/* ---------------------------------------------------------------------------
 * Session handling
 *
 * The backend issues short-lived access tokens and rotating refresh tokens.
 * Refreshes are single-flight so parallel requests share one call.
 * ------------------------------------------------------------------------- */

const EXPIRY_SKEW_MS = 30_000;

function decodeJwtExpiry(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;

    const normalized = payload
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const json = JSON.parse(atob(normalized)) as {
      exp?: unknown;
    };

    return typeof json.exp === "number"
      ? json.exp * 1000
      : null;
  } catch {
    return null;
  }
}

let refreshInFlight: Promise<string | null> | null = null;

function isExpiredByClock(token: string | null): boolean {
  if (!token) return true;

  const expiresAt = decodeJwtExpiry(token);

  return (
    expiresAt !== null &&
    expiresAt - Date.now() <= EXPIRY_SKEW_MS
  );
}

/**
 * Exchanges the refresh token for a new pair.
 * If another tab has already refreshed, reuse its session where possible.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const { refreshToken, setAuth, clearAuth } =
      useAuthStore.getState();

    if (!refreshToken) return null;

    try {
      const response = await fetch(
        `${API_URL}/auth/refresh`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ refreshToken }),
        },
      );

      if (response.ok) {
        const data = normalizeAuthResponse(
          (await response.json()) as AuthResponsePayload,
        );

        setAuth(data);
        return data.accessToken;
      }

      if (response.status >= 500) {
        // Backend trouble, not necessarily an invalid session.
        return useAuthStore.getState().accessToken;
      }

      // Another tab may already have rotated the refresh token.
      await useAuthStore.persist?.rehydrate?.();

      const latest = useAuthStore.getState();

      if (
        latest.refreshToken &&
        latest.refreshToken !== refreshToken &&
        !isExpiredByClock(latest.accessToken)
      ) {
        return latest.accessToken;
      }

      clearAuth();
      return null;
    } catch {
      // Network failure: retain the current session.
      return useAuthStore.getState().accessToken;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Returns a usable access token, refreshing it when necessary. */
export async function getValidAccessToken(): Promise<string | null> {
  const { accessToken, refreshToken } =
    useAuthStore.getState();

  if (!accessToken) return null;

  if (
    !isExpiredByClock(accessToken) ||
    !refreshToken
  ) {
    return accessToken;
  }

  return refreshAccessToken();
}

function looksLikeAuthFailure(
  status: number,
  tokenUsed: string | null,
) {
  return (
    status === 401 ||
    (status === 403 && isExpiredByClock(tokenUsed))
  );
}

type ErrorBody = {
  message: string;
  albumId: string | null;
};

async function readErrorBody(
  response: Response,
  fallback: string,
): Promise<ErrorBody> {
  try {
    const body = (await response.json()) as {
      message?: unknown;
      albumId?: unknown;
    };

    return {
      message:
        typeof body?.message === "string" &&
        body.message.trim()
          ? body.message
          : fallback,
      albumId:
        typeof body?.albumId === "string"
          ? body.albumId
          : null,
    };
  } catch {
    return {
      message: fallback,
      albumId: null,
    };
  }
}

const SERVER_ERROR_MESSAGE =
  "The server couldn't complete this action. Please try again.";

async function request<T>(
  path: string,
  options: RequestInit = {},
  auth = true,
): Promise<T> {
  const send = async (token: string | null) => {
    const headers = new Headers(options.headers);

    if (!(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }

    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    // Proof of the PINs entered this session for locked albums.
    const albumTokens =
      useAlbumLockStore.getState().headerValue();

    if (albumTokens) {
      headers.set("X-Album-Token", albumTokens);
    }

    return fetch(`${API_URL}${path}`, {
      ...options,
      headers,
    });
  };

  let token = auth
    ? await getValidAccessToken()
    : null;

  let response = await send(token);

  if (
    auth &&
    looksLikeAuthFailure(response.status, token) &&
    useAuthStore.getState().refreshToken
  ) {
    const refreshed = await refreshAccessToken();

    if (refreshed) {
      token = refreshed;
      response = await send(refreshed);
    }
  }

  if (!response.ok) {
    if (
      auth &&
      looksLikeAuthFailure(response.status, token)
    ) {
      useAuthStore.getState().clearAuth();

      throw new ApiError(
        "Your session has expired. Please sign in again.",
        response.status,
      );
    }

    const fallback =
      response.status >= 500 ||
      response.status === 403
        ? SERVER_ERROR_MESSAGE
        : "Request failed";

    const body = await readErrorBody(
      response,
      fallback,
    );

    throw new ApiError(
      body.message,
      response.status,
      body.albumId,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/* ---------------------------------------------------------------------------
 * API methods
 * Authentication routes match AuthController's /api/auth mapping.
 * Other routes remain as supplied in your original file.
 * ------------------------------------------------------------------------- */

export const api = {
  register: async (body: {
    email: string;
    password: string;
    displayName: string;
  }) =>
    normalizeAuthResponse(
      await request<AuthResponsePayload>(
        "/auth/register",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        false,
      ),
    ),

  login: async (body: {
    email: string;
    password: string;
  }) =>
    normalizeAuthResponse(
      await request<AuthResponsePayload>(
        "/auth/login",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        false,
      ),
    ),

  logout: () => {
    const refreshToken =
      useAuthStore.getState().refreshToken;

    return request<void>(
      "/auth/logout",
      {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      },
      false,
    );
  },

  me: () => request<User>("/auth/me"),

  getPhoto: (photoId: string) =>
    request<Photo>(`/photos/${photoId}`),

  getPhotos: ({
    status = "ACTIVE",
    page = 0,
    size = 24,
    q,
    sort,
  }: PhotoListParams = {}) => {
    const params = new URLSearchParams({
      status,
      page: String(page),
      size: String(size),
    });

    if (q && q.trim()) {
      params.set("q", q.trim());
    }

    if (sort && sort !== "newest") {
      params.set("sort", sort);
    }

    return request<PageResponse<Photo>>(
      `/photos?${params.toString()}`,
    );
  },

  getPhotoVersions: (photoId: string) =>
    request<PhotoVersions>(
      `/photos/${photoId}/versions`,
    ),

  previewEdit: (
    photoId: string,
    body: EditRequest,
  ) =>
    request<EditPreviewResponse>(
      `/photos/${photoId}/edits/preview`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  applyEdit: (
    photoId: string,
    body: EditRequest,
  ) =>
    request<Photo>(
      `/photos/${photoId}/edits/apply`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  archivePhotos: (photoIds: string[]) =>
    request<void>("/photos/archive", {
      method: "POST",
      body: JSON.stringify({ photoIds }),
    }),

  trashPhotos: (photoIds: string[]) =>
    request<void>("/photos/trash", {
      method: "POST",
      body: JSON.stringify({ photoIds }),
    }),

  restorePhotos: (photoIds: string[]) =>
    request<void>("/photos/restore", {
      method: "POST",
      body: JSON.stringify({ photoIds }),
    }),

  permanentlyDeletePhotos: (photoIds: string[]) =>
    request<void>("/photos/delete-permanent", {
      method: "POST",
      body: JSON.stringify({ photoIds }),
    }),

  getAlbums: () =>
    request<Album[]>("/albums"),

  getAlbum: (albumId: string) =>
    request<Album>(`/albums/${albumId}`),

  createAlbum: (title: string) =>
    request<Album>("/albums", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  updateAlbum: (
    albumId: string,
    body: UpdateAlbumRequest,
  ) =>
    request<Album>(`/albums/${albumId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteAlbum: (albumId: string) =>
    request<void>(`/albums/${albumId}`, {
      method: "DELETE",
    }),

  getAlbumPhotos: (
    albumId: string,
    page = 0,
    size = 24,
  ) =>
    request<PageResponse<Photo>>(
      `/albums/${albumId}/photos?page=${page}&size=${size}`,
    ),

  addPhotosToAlbum: (
    albumId: string,
    photoIds: string[],
  ) =>
    request<void>(`/albums/${albumId}/photos`, {
      method: "POST",
      body: JSON.stringify({ photoIds }),
    }),

  removePhotoFromAlbum: (
    albumId: string,
    photoId: string,
  ) =>
    request<void>(
      `/albums/${albumId}/photos/${photoId}`,
      {
        method: "DELETE",
      },
    ),

  lockAlbum: (albumId: string, pin: string) =>
    request<Album>(`/albums/${albumId}/lock`, {
      method: "POST",
      body: JSON.stringify({ pin }),
    }),

  changeAlbumPin: (
    albumId: string,
    currentPin: string,
    newPin: string,
  ) =>
    request<void>(`/albums/${albumId}/lock`, {
      method: "PATCH",
      body: JSON.stringify({ currentPin, newPin }),
    }),

  removeAlbumLock: (
    albumId: string,
    proof: {
      pin?: string;
      password?: string;
    },
  ) =>
    request<Album>(
      `/albums/${albumId}/lock/remove`,
      {
        method: "POST",
        body: JSON.stringify(proof),
      },
    ),

  unlockAlbum: (
    albumId: string,
    pin: string,
  ) =>
    request<AlbumUnlockResponse>(
      `/albums/${albumId}/unlock`,
      {
        method: "POST",
        body: JSON.stringify({ pin }),
      },
    ),

  previewAiTransform: (
    photoId: string,
    body: AiTransformRequest,
  ) =>
    request<AiTransformPreviewResponse>(
      `/photos/${photoId}/ai/preview`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  applyAiTransform: (
    photoId: string,
    body: AiTransformRequest,
  ) =>
    request<Photo>(
      `/photos/${photoId}/ai/apply`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  getStorageUsage: () =>
    request<StorageUsageResponse>("/library/storage"),

  getImageKitAssets: () =>
    request<ImageKitAsset[]>("/library/imagekit-assets"),

  importImageKitAssets: (imagekitFileIds: string[]) =>
    request<Photo[]>("/library/import", {
      method: "POST",
      body: JSON.stringify({ imagekitFileIds }),
    }),
};
