// All reads/writes to Firestore for the signed-in user.
// Layout: users/{uid}/profile/me, users/{uid}/chats/{id}/messages/*,
//         users/{uid}/memories/*, users/{uid}/schedules/*
import {
  db,
  auth,
  collection,
  doc,
  addDoc,
  setDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
  onSnapshot,
  Timestamp,
} from "./firebase.js";

const uid = () => {
  const u = auth.currentUser;
  if (!u) throw new Error("Not signed in");
  return u.uid;
};
const userDoc = (...path) => doc(db, "users", uid(), ...path);
const userCol = (...path) => collection(db, "users", uid(), ...path);
const toList = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// ---------- Profile ----------
export function saveProfile(name) {
  return setDoc(userDoc("profile", "me"), { name, updatedAt: serverTimestamp() }, { merge: true });
}

// ---------- Chats ----------
export function watchChats(cb) {
  const q = query(userCol("chats"), orderBy("updatedAt", "desc"), limit(100));
  return onSnapshot(q, (snap) => cb(toList(snap)), (err) => console.error("watchChats", err));
}

export async function createChat(title) {
  const ref = await addDoc(userCol("chats"), {
    title,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export function touchChat(chatId) {
  return updateDoc(userDoc("chats", chatId), { updatedAt: serverTimestamp() });
}

export async function deleteChat(chatId) {
  const msgs = await getDocs(userCol("chats", chatId, "messages"));
  await Promise.all(msgs.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(userDoc("chats", chatId));
}

export function addMessage(chatId, message) {
  return addDoc(userCol("chats", chatId, "messages"), { ...message, createdAt: serverTimestamp() });
}

export async function loadMessages(chatId) {
  const snap = await getDocs(query(userCol("chats", chatId, "messages"), orderBy("createdAt", "asc")));
  return toList(snap);
}

// ---------- Memory ----------
export async function listMemories() {
  const snap = await getDocs(query(userCol("memories"), orderBy("createdAt", "desc"), limit(50)));
  return toList(snap);
}

export function addMemory(text) {
  return addDoc(userCol("memories"), { text: text.slice(0, 500), createdAt: serverTimestamp() });
}

export function deleteMemory(id) {
  return deleteDoc(userDoc("memories", id));
}

// ---------- Schedule ----------
export function watchSchedules(cb) {
  const q = query(userCol("schedules"), orderBy("runAt", "asc"), limit(200));
  return onSnapshot(q, (snap) =>
    cb(
      snap.docs.map((d) => {
        const x = d.data();
        return { id: d.id, ...x, runAt: x.runAt?.toDate?.() ?? new Date() };
      })
    )
  );
}

export function addSchedule(item) {
  return addDoc(userCol("schedules"), {
    ...item,
    runAt: Timestamp.fromDate(item.runAt),
    createdAt: serverTimestamp(),
  });
}

export function updateSchedule(id, patch) {
  const p = { ...patch };
  if (p.runAt instanceof Date) p.runAt = Timestamp.fromDate(p.runAt);
  return updateDoc(userDoc("schedules", id), p);
}

export function deleteSchedule(id) {
  return deleteDoc(userDoc("schedules", id));
}
