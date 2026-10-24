export const firebaseConfig = {
  apiKey: "AIzaSyD6m1YNPnnmcA34rX8vWZpmiH9dN09JE1I",
  authDomain: "kiki-firebase-2.firebaseapp.com",
  projectId: "kiki-firebase-2",
  storageBucket: "kiki-firebase-2.firebasestorage.app",
  messagingSenderId: "920335088675",
  appId: "1:920335088675:web:0f8dc438ba3bd33456c596"
};

export const isFirebaseConfigured = !Object.values(firebaseConfig).some(value =>
  value.startsWith("YOUR_")
);