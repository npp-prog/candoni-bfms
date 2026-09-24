const e = import.meta.env;

export const env = {
  firebase: {
    apiKey: e.VITE_FIREBASE_API_KEY as string,
    authDomain: e.VITE_FIREBASE_AUTH_DOMAIN as string,
    projectId: (e.VITE_FIREBASE_PROJECT_ID as string) || 'demo-bfms',
    storageBucket: e.VITE_FIREBASE_STORAGE_BUCKET as string,
    messagingSenderId: e.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
    appId: e.VITE_FIREBASE_APP_ID as string,
  },
  functionsRegion: (e.VITE_FUNCTIONS_REGION as string) || 'asia-southeast1',
  appEnv: ((e.VITE_APP_ENV as string) || 'dev') as 'dev' | 'staging' | 'prod',
  useEmulators: e.VITE_USE_EMULATORS === 'true',
};
