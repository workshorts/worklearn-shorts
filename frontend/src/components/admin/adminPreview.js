// Explicit local preview; never enabled in a production build.
export const adminPreview = import.meta.env.DEV && import.meta.env.VITE_ADMIN_PREVIEW === 'true'
