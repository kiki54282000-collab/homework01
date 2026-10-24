import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  deleteObject,
  getDownloadURL,
  getStorage,
  ref as storageRef,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const byId = id => document.getElementById(id);
const productGrid = byId("productGrid");
const productNotice = byId("productNotice");
const memberDialog = byId("memberDialog");
const cartDialog = byId("cartDialog");
const productDialog = byId("productDialog");
const adminDialog = byId("adminDialog");
const memberTrigger = byId("memberTrigger");
const toast = byId("cartToast");
const productsById = new Map();
let auth;
let db;
let storage;
let functions;
let currentUser = null;
let isAdmin = false;
let activeFilter = "全部";
let productUnsubscribe = null;
let cartUnsubscribe = null;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function formatPrice(price) {
  return `NT$ ${new Intl.NumberFormat("zh-TW").format(price)}`;
}

function showFirebaseError(error) {
  const messages = {
    "auth/email-already-in-use": "這個 Email 已註冊，請直接登入。",
    "auth/invalid-credential": "Email 或密碼不正確。",
    "auth/invalid-email": "Email 格式不正確。",
    "auth/weak-password": "密碼強度不足，請至少使用 8 個字元。",
    "auth/network-request-failed": "網路連線失敗，請稍後再試。",
    "storage/unauthorized": "圖片上傳遭拒，請確認管理者權限與 Storage Rules。",
    "storage/bucket-not-found": "找不到 Firebase Storage bucket，請先在 Firebase Console 啟用 Cloud Storage。",
    "permission-denied": "目前帳號沒有執行此操作的權限。",
    "unauthenticated": "請先登入會員。",
    "failed-precondition": error.message || "目前無法完成此操作，請檢查商品或會員狀態。",
    "already-exists": error.message || "已有結帳程序進行中。"
  };
  return messages[error.code?.replace(/^functions\//, "")] || "操作失敗，請稍後再試。";
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

document.querySelectorAll("[data-close-dialog]").forEach(button => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
[memberDialog, cartDialog, productDialog, adminDialog].forEach(dialog => {
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });
});

function applyProductFilters() {
  const term = byId("search").value.trim().toLocaleLowerCase("zh-TW");
  const cards = [...productGrid.querySelectorAll(".product-card")];
  let visibleCount = 0;
  cards.forEach(card => {
    const product = productsById.get(card.dataset.productId);
    const categoryMatch = activeFilter === "全部" || product?.category === activeFilter;
    const searchMatch = !term || `${product?.name || ""} ${product?.material || ""}`.toLocaleLowerCase("zh-TW").includes(term);
    card.hidden = !(categoryMatch && searchMatch);
    if (!card.hidden) visibleCount++;
  });
  byId("resultCount").textContent = `找到 ${visibleCount} 件商品`;
}

function productCard(productId, product) {
  const card = document.createElement("article");
  card.className = "product-card";
  card.dataset.productId = productId;

  const image = document.createElement("img");
  image.src = product.imageUrl;
  image.alt = product.name;
  image.loading = "lazy";

  const imageBox = document.createElement("div");
  imageBox.className = "product-image";
  imageBox.append(image);
  if (product.tag) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = product.tag;
    imageBox.append(tag);
  }

  const info = document.createElement("div");
  info.className = "product-info";
  const openButton = document.createElement("button");
  openButton.className = "product-open";
  openButton.type = "button";
  const heading = document.createElement("h3");
  heading.textContent = product.name;
  openButton.append(heading);
  openButton.addEventListener("click", () => showProductDetails(productId));

  const material = document.createElement("div");
  material.className = "product-meta";
  material.textContent = product.material || product.category || "天然石設計";

  const priceRow = document.createElement("div");
  priceRow.className = "price-row";
  const price = document.createElement("span");
  price.className = "price";
  price.textContent = formatPrice(product.price);
  const stock = document.createElement("span");
  stock.className = "product-stock";
  stock.textContent = product.stock > 0 ? `庫存 ${product.stock}` : "暫時售完";
  priceRow.append(price, stock);

  const addButton = document.createElement("button");
  addButton.className = "add-btn";
  addButton.type = "button";
  addButton.dataset.product = product.name;
  addButton.textContent = "加入購物車";
  addButton.disabled = !product.stock;
  addButton.addEventListener("click", () => addToCart(productId));

  info.append(openButton, material, priceRow, addButton);
  card.append(imageBox, info);
  return card;
}

function renderProducts(snapshot) {
  productsById.clear();
  productGrid.replaceChildren();
    const products = snapshot.docs
    .map(document => ({ id: document.id, ...document.data() }))
    .filter(product => product.active === true && Number.isInteger(product.price) && product.price > 0)
    .sort((first, second) => (second.updatedAt?.toMillis?.() || 0) - (first.updatedAt?.toMillis?.() || 0));

  products.forEach(product => {
    productsById.set(product.id, product);
    productGrid.append(productCard(product.id, product));
  });
  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "目前沒有上架商品，請稍後再來看看。";
    productGrid.append(empty);
  }
  applyProductFilters();
  if (isAdmin && adminDialog.open) renderAdminProducts(snapshot.docs);
}

function startProductListener() {
  if (productUnsubscribe) productUnsubscribe();
  productUnsubscribe = onSnapshot(
    query(collection(db, "products"), where("active", "==", true)),
    renderProducts,
    error => {
      console.error("Product subscription failed", error);
      productGrid.innerHTML = "";
      const message = document.createElement("p");
      message.className = "empty-state";
      message.textContent = "商品載入失敗，請稍後重新整理。";
      productGrid.append(message);
      setMessage(productNotice, showFirebaseError(error), true);
    }
  );
}

async function showProductDetails(productId) {
  const product = productsById.get(productId);
  if (!product) return;
  byId("detailImage").src = product.imageUrl;
  byId("detailImage").alt = product.name;
  byId("detailCategory").textContent = product.category || "JADE VERSE";
  byId("detailName").textContent = product.name;
  byId("detailPrice").textContent = formatPrice(product.price);
  byId("detailDescription").textContent = product.description || product.material || "天然石作品，請聯絡客服了解更多材質細節。";
  byId("detailStock").textContent = product.stock > 0 ? `庫存 ${product.stock}` : "暫時售完";
  byId("detailAdd").disabled = !product.stock;
  byId("detailAdd").dataset.productId = productId;
  openDialog(productDialog);
}

async function addToCart(productId, quantity = 1) {
  if (!currentUser) {
      memberDialog.dataset.returnToCart = "true";
    memberDialog.dataset.pendingProductId = productId;
    openDialog(memberDialog);
    setMessage(byId("loginMessage"), "登入會員後即可將商品加入雲端購物車。", true);
    return;
  }
  const product = productsById.get(productId);
  if (!product) return;
  try {
    const cartRef = doc(db, "users", currentUser.uid, "cart", productId);
    await runTransaction(db, async transaction => {
      const [cartSnapshot, productSnapshot] = await Promise.all([
        transaction.get(cartRef),
        transaction.get(doc(db, "products", productId))
      ]);
      const liveProduct = productSnapshot.data();
      const nextQuantity = (cartSnapshot.exists() ? cartSnapshot.data().quantity : 0) + quantity;
      if (!productSnapshot.exists() || liveProduct.active !== true) throw new Error("商品已下架。");
      if (nextQuantity > 10 || nextQuantity > liveProduct.stock) throw new Error("數量超過可購買庫存。");
      transaction.set(cartRef, { productId, quantity: nextQuantity, updatedAt: serverTimestamp() });
    });
    showToast(`「${product.name}」已加入購物車`);
    if (productDialog.open) productDialog.close();
  } catch (error) {
    showToast(error.message || showFirebaseError(error));
  }
}

async function renderCart(snapshot) {
  const container = byId("cartItems");
  container.replaceChildren();
    const rows = await Promise.all(snapshot.docs.map(async itemDocument => {
    const item = itemDocument.data();
    const productSnapshot = await getDoc(doc(db, "products", itemDocument.id));
    return { id: itemDocument.id, quantity: item.quantity, product: productSnapshot.data() };
  }));
  const activeRows = rows.filter(row => row.product?.active === true);
  const count = activeRows.reduce((sum, row) => sum + row.quantity, 0);
  byId("cartCount").textContent = String(count);
  if (!activeRows.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "購物車是空的。到商品區挑選一件喜歡的作品吧。";
    container.append(empty);
    byId("cartTotal").textContent = formatPrice(0);
    byId("checkoutButton").disabled = true;
    return;
  }

  let total = 0;
  activeRows.forEach(row => {
    total += row.product.price * row.quantity;
    const element = document.createElement("article");
    element.className = "cart-row";
    const image = document.createElement("img");
    image.src = row.product.imageUrl;
    image.alt = row.product.name;
    const main = document.createElement("div");
    main.className = "cart-row-main";
    const name = document.createElement("strong");
    name.textContent = row.product.name;
    const price = document.createElement("small");
    price.textContent = formatPrice(row.product.price);
    main.append(name, price);
    const actions = document.createElement("div");
    actions.className = "cart-row-actions";
    const minus = document.createElement("button");
    minus.className = "cart-stepper";
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", `減少${row.product.name}數量`);
    minus.addEventListener("click", () => changeCartQuantity(row.id, row.quantity - 1));
    const quantity = document.createElement("span");
    quantity.className = "cart-quantity";
    quantity.textContent = String(row.quantity);
    const plus = document.createElement("button");
    plus.className = "cart-stepper";
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", `增加${row.product.name}數量`);
    plus.disabled = row.quantity >= 10 || row.quantity >= row.product.stock;
    plus.addEventListener("click", () => changeCartQuantity(row.id, row.quantity + 1));
    const remove = document.createElement("button");
    remove.className = "cart-remove";
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => changeCartQuantity(row.id, 0));
    actions.append(minus, quantity, plus, remove);
    element.append(image, main, actions);
    container.append(element);
  });
  byId("cartTotal").textContent = formatPrice(total);
  byId("checkoutButton").disabled = false;
}

async function changeCartQuantity(productId, quantity) {
  if (!currentUser) return;
  const itemRef = doc(db, "users", currentUser.uid, "cart", productId);
    try {
    if (quantity <= 0) {
      await deleteDoc(itemRef);
      return;
    }
    await runTransaction(db, async transaction => {
      const productRef = doc(db, "products", productId);
      const [itemSnapshot, productSnapshot] = await Promise.all([
        transaction.get(itemRef),
        transaction.get(productRef)
      ]);
      if (!itemSnapshot.exists() || !productSnapshot.exists()) throw new Error("商品已不存在。");
      const product = productSnapshot.data();
      if (!product.active || quantity > product.stock || quantity > 10) throw new Error("數量超過目前庫存。");
      transaction.update(itemRef, { quantity, updatedAt: serverTimestamp() });
    });
  } catch (error) {
    setMessage(byId("cartMessage"), error.message || showFirebaseError(error), true);
  }
}

function setMemberTab(tab) {
  const loginSelected = tab === "login";
  byId("loginTab").setAttribute("aria-selected", String(loginSelected));
  byId("signupTab").setAttribute("aria-selected", String(!loginSelected));
  byId("loginForm").hidden = !loginSelected;
  byId("signupForm").hidden = loginSelected;
  setMessage(byId("loginMessage"), "");
  setMessage(byId("signupMessage"), "");
}

function showMemberError(element, error) {
  setMessage(element, showFirebaseError(error), true);
  }

async function ensureProfile(user, displayName = user.displayName || "") {
  const profileRef = doc(db, "users", user.uid);
  const profileSnapshot = await getDoc(profileRef);
  if (!profileSnapshot.exists()) {
    await setDoc(profileRef, {
      displayName,
      email: user.email || "",
      phone: "",
      updatedAt: serverTimestamp()
    });
  }
  return getDoc(profileRef);
}

async function loadProfile(user) {
  const message = byId("profileMessage");
  try {
    const profileSnapshot = await ensureProfile(user);
    const profile = profileSnapshot.data();
    byId("profileForm").elements.email.value = user.email || "";
    byId("profileForm").elements.displayName.value = profile.displayName || user.displayName || "";
    byId("profileForm").elements.phone.value = profile.phone || "";
    byId("memberStatus").textContent = `已登入：${user.email}`;
    byId("memberAuthView").hidden = true;
    byId("memberProfile").hidden = false;
    memberTrigger.setAttribute("aria-label", `會員中心，${profile.displayName || user.email}已登入`);
    await loadOrders(user);
    await loadAdminState(user);
  } catch (error) {
    showMemberError(message, error);
  }
}

async function loadOrders(user) {
  const list = byId("orderList");
  list.replaceChildren();
    try {
    const ordersSnapshot = await getDocs(collection(db, "users", user.uid, "orders"));
    const orders = ordersSnapshot.docs
      .map(orderDocument => ({ id: orderDocument.id, ...orderDocument.data() }))
      .sort((first, second) => (second.createdAt?.toMillis?.() || 0) - (first.createdAt?.toMillis?.() || 0));
    if (!orders.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "目前沒有訂單紀錄。付款完成後，訂單會顯示在這裡。";
      list.append(empty);
      return;
    }
    orders.forEach(order => {
      const row = document.createElement("div");
      row.className = "order-row";
      const info = document.createElement("div");
      const orderName = document.createElement("strong");
      orderName.textContent = `訂單 ${order.id.slice(0, 8)}`;
      const summary = document.createElement("small");
      summary.textContent = `${order.items?.length || 0} 項商品・${order.status}`;
      info.append(orderName, summary);
      const total = document.createElement("span");
      total.textContent = formatPrice(order.total || 0);
      row.append(info, total);
      list.append(row);
    });
  } catch (error) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = showFirebaseError(error);
    list.append(empty);
  }
}

async function loadAdminState(user) {
  try {
    const adminSnapshot = await getDoc(doc(db, "admins", user.uid));
    isAdmin = adminSnapshot.exists() && adminSnapshot.data().enabled === true;
    byId("adminTrigger").hidden = !isAdmin;
  } catch (error) {
    isAdmin = false;
    byId("adminTrigger").hidden = true;
    console.error("Admin role check failed", error);
  }
}

async function legacyAddToCart(productId, quantity = 1) {
  if (!currentUser) {
    memberDialog.dataset.returnToCart = "true";
    memberDialog.dataset.pendingProductId = productId;
    byId("memberProfile").hidden = true;
    byId("memberAuthView").hidden = false;
    setMemberTab("login");
    setMessage(byId("loginMessage"), "登入會員後即可將商品加入購物車。", true);
    openDialog(memberDialog);
    return;
  }
  const product = productsById.get(productId);
  if (!product) return;
  try {
    const cartRef = doc(db, "users", currentUser.uid, "cart", productId);
    await runTransaction(db, async transaction => {
      const [cartSnapshot, productSnapshot] = await Promise.all([
        transaction.get(cartRef),
        transaction.get(doc(db, "products", productId))
      ]);
      const liveProduct = productSnapshot.data();
      const nextQuantity = (cartSnapshot.exists() ? cartSnapshot.data().quantity : 0) + quantity;
      if (!productSnapshot.exists() || liveProduct.active !== true) throw new Error("商品已下架。");
      if (nextQuantity > 10 || nextQuantity > liveProduct.stock) throw new Error("數量超過可購買庫存。");
      transaction.set(cartRef, { productId, quantity: nextQuantity, updatedAt: serverTimestamp() });
    });
    showToast(`「${product.name}」已加入購物車`);
    if (productDialog.open) productDialog.close();
  } catch (error) {
    showToast(error.message || showFirebaseError(error));
  }
}

async function legacyRenderCart(snapshot) {
  const container = byId("cartItems");
  container.replaceChildren();
  const rows = await Promise.all(snapshot.docs.map(async itemDocument => {
    const item = itemDocument.data();
    const productSnapshot = await getDoc(doc(db, "products", itemDocument.id));
    return { id: itemDocument.id, quantity: item.quantity, product: productSnapshot.data() };
  }));
  const activeRows = rows.filter(row => row.product?.active === true);
  const count = activeRows.reduce((sum, row) => sum + row.quantity, 0);
  byId("cartCount").textContent = String(count);
  if (!activeRows.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "購物車是空的。到商品區挑選一件喜歡的作品吧。";
    container.append(empty);
    byId("cartTotal").textContent = formatPrice(0);
    byId("checkoutButton").disabled = true;
    return;
  }
  let total = 0;
  activeRows.forEach(row => {
    total += row.product.price * row.quantity;
    const element = document.createElement("article");
    element.className = "cart-row";
    const image = document.createElement("img");
    image.src = row.product.imageUrl;
    image.alt = row.product.name;
    const main = document.createElement("div");
    main.className = "cart-row-main";
    const name = document.createElement("strong");
    name.textContent = row.product.name;
    const price = document.createElement("small");
    price.textContent = formatPrice(row.product.price);
    main.append(name, price);
    const actions = document.createElement("div");
    actions.className = "cart-row-actions";
    const minus = document.createElement("button");
    minus.className = "cart-stepper";
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", `減少${row.product.name}數量`);
    minus.addEventListener("click", () => changeCartQuantity(row.id, row.quantity - 1));
    const quantity = document.createElement("span");
    quantity.className = "cart-quantity";
    quantity.textContent = String(row.quantity);
    const plus = document.createElement("button");
    plus.className = "cart-stepper";
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", `增加${row.product.name}數量`);
    plus.disabled = row.quantity >= 10 || row.quantity >= row.product.stock;
    plus.addEventListener("click", () => changeCartQuantity(row.id, row.quantity + 1));
    const remove = document.createElement("button");
    remove.className = "cart-remove";
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => changeCartQuantity(row.id, 0));
    actions.append(minus, quantity, plus, remove);
    element.append(image, main, actions);
    container.append(element);
  });
  byId("cartTotal").textContent = formatPrice(total);
  byId("checkoutButton").disabled = false;
}

async function legacyChangeCartQuantity(productId, quantity) {
  if (!currentUser) return;
  const itemRef = doc(db, "users", currentUser.uid, "cart", productId);
  try {
    if (quantity <= 0) {
      await deleteDoc(itemRef);
      return;
    }
    await runTransaction(db, async transaction => {
      const productRef = doc(db, "products", productId);
      const [itemSnapshot, productSnapshot] = await Promise.all([
        transaction.get(itemRef),
        transaction.get(productRef)
      ]);
      if (!itemSnapshot.exists() || !productSnapshot.exists()) throw new Error("商品已不存在。");
      const product = productSnapshot.data();
      if (!product.active || quantity > product.stock || quantity > 10) throw new Error("數量超過目前庫存。");
      transaction.update(itemRef, { quantity, updatedAt: serverTimestamp() });
    });
  } catch (error) {
    setMessage(byId("cartMessage"), error.message || showFirebaseError(error), true);
  }
}

async function legacyShowProductDetails(productId) {
  const product = productsById.get(productId);
  if (!product) return;
  byId("detailImage").src = product.imageUrl;
  byId("detailImage").alt = product.name;
  byId("detailCategory").textContent = product.category || "JADE VERSE";
  byId("detailName").textContent = product.name;
  byId("detailPrice").textContent = formatPrice(product.price);
  byId("detailDescription").textContent = product.description || product.material || "天然石作品，請聯絡客服了解更多材質細節。";
  byId("detailStock").textContent = product.stock > 0 ? `庫存 ${product.stock}` : "暫時售完";
  byId("detailAdd").disabled = !product.stock;
  byId("detailAdd").dataset.productId = productId;
  openDialog(productDialog);
}

function legacyApplyProductFilters() {
  const term = byId("search").value.trim().toLocaleLowerCase("zh-TW");
  const cards = [...productGrid.querySelectorAll(".product-card")];
  let visibleCount = 0;
  cards.forEach(card => {
    const product = productsById.get(card.dataset.productId);
    const categoryMatch = activeFilter === "全部" || product?.category === activeFilter;
    const searchMatch = !term || `${product?.name || ""} ${product?.material || ""}`.toLocaleLowerCase("zh-TW").includes(term);
    card.hidden = !(categoryMatch && searchMatch);
    if (!card.hidden) visibleCount++;
  });
  byId("resultCount").textContent = `找到 ${visibleCount} 件商品`;
}

function legacyRenderProducts(snapshot) {
  productsById.clear();
  productGrid.replaceChildren();
  const products = snapshot.docs
    .map(document => ({ id: document.id, ...document.data() }))
    .filter(product => product.active === true && Number.isInteger(product.price) && product.price > 0)
    .sort((first, second) => (second.updatedAt?.toMillis?.() || 0) - (first.updatedAt?.toMillis?.() || 0));
  products.forEach(product => {
    productsById.set(product.id, product);
    productGrid.append(productCard(product.id, product));
  });
  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "目前沒有上架商品，請稍後再來看看。";
    productGrid.append(empty);
  }
  applyProductFilters();
  if (isAdmin && adminDialog.open) loadAdminProducts();
}

function legacyProductCard(productId, product) {
  const card = document.createElement("article");
  card.className = "product-card";
  card.dataset.productId = productId;
  const image = document.createElement("img");
  image.src = product.imageUrl;
  image.alt = product.name;
  image.loading = "lazy";
  const imageBox = document.createElement("div");
  imageBox.className = "product-image";
  imageBox.append(image);
  if (product.tag) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = product.tag;
    imageBox.append(tag);
  }
  const info = document.createElement("div");
  info.className = "product-info";
  const openButton = document.createElement("button");
  openButton.className = "product-open";
  openButton.type = "button";
  const heading = document.createElement("h3");
  heading.textContent = product.name;
  openButton.append(heading);
  openButton.addEventListener("click", () => showProductDetails(productId));
  const material = document.createElement("div");
  material.className = "product-meta";
  material.textContent = product.material || product.category || "天然石設計";
  const priceRow = document.createElement("div");
  priceRow.className = "price-row";
  const price = document.createElement("span");
  price.className = "price";
  price.textContent = formatPrice(product.price);
  const stock = document.createElement("span");
  stock.className = "product-stock";
  stock.textContent = product.stock > 0 ? `庫存 ${product.stock}` : "暫時售完";
  priceRow.append(price, stock);
  const addButton = document.createElement("button");
  addButton.className = "add-btn";
  addButton.type = "button";
  addButton.textContent = "加入購物車";
  addButton.disabled = !product.stock;
  addButton.addEventListener("click", () => addToCart(productId));
  info.append(openButton, material, priceRow, addButton);
  card.append(imageBox, info);
  return card;
}

function legacySetMemberTab(tab) {
  const loginSelected = tab === "login";
  byId("loginTab").setAttribute("aria-selected", String(loginSelected));
  byId("signupTab").setAttribute("aria-selected", String(!loginSelected));
  byId("loginForm").hidden = !loginSelected;
  byId("signupForm").hidden = loginSelected;
  setMessage(byId("loginMessage"), "");
  setMessage(byId("signupMessage"), "");
}

function legacyShowMemberError(element, error) {
  setMessage(element, showFirebaseError(error), true);
}

async function legacyEnsureProfile(user, displayName = user.displayName || "") {
  const profileRef = doc(db, "users", user.uid);
  const profileSnapshot = await getDoc(profileRef);
  if (!profileSnapshot.exists()) {
    await setDoc(profileRef, { displayName, email: user.email || "", phone: "", updatedAt: serverTimestamp() });
  }
  return getDoc(profileRef);
}

async function legacyLoadOrders(user) {
  const list = byId("orderList");
  list.replaceChildren();
  try {
    const ordersSnapshot = await getDocs(collection(db, "users", user.uid, "orders"));
    const orders = ordersSnapshot.docs.map(orderDocument => ({ id: orderDocument.id, ...orderDocument.data() }))
      .sort((first, second) => (second.createdAt?.toMillis?.() || 0) - (first.createdAt?.toMillis?.() || 0));
    if (!orders.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "目前沒有訂單紀錄。付款完成後，訂單會顯示在這裡。";
      list.append(empty);
      return;
    }
    orders.forEach(order => {
      const row = document.createElement("div");
      row.className = "order-row";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `訂單 ${order.id.slice(0, 8)}`;
      const summary = document.createElement("small");
      summary.textContent = `${order.items?.length || 0} 項商品・${order.status}`;
      info.append(title, summary);
      const total = document.createElement("span");
      total.textContent = formatPrice(order.total || 0);
      row.append(info, total);
      list.append(row);
    });
  } catch (error) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = showFirebaseError(error);
    list.append(empty);
  }
}

async function legacyLoadProfile(user) {
  try {
    const profileSnapshot = await ensureProfile(user);
    const profile = profileSnapshot.data();
    byId("profileForm").elements.email.value = user.email || "";
    byId("profileForm").elements.displayName.value = profile.displayName || user.displayName || "";
    byId("profileForm").elements.phone.value = profile.phone || "";
    byId("memberStatus").textContent = `已登入：${user.email}`;
    byId("memberAuthView").hidden = true;
    byId("memberProfile").hidden = false;
    memberTrigger.setAttribute("aria-label", `會員中心，${profile.displayName || user.email}已登入`);
    await Promise.all([loadOrders(user), loadAdminState(user)]);
  } catch (error) {
    showMemberError(byId("profileMessage"), error);
  }
}

async function legacyLoadAdminState(user) {
  try {
    const adminSnapshot = await getDoc(doc(db, "admins", user.uid));
    isAdmin = adminSnapshot.exists() && adminSnapshot.data().enabled === true;
    byId("adminTrigger").hidden = !isAdmin;
  } catch {
    isAdmin = false;
    byId("adminTrigger").hidden = true;
  }
}

async function loadAdminProducts() {
  const list = byId("adminProductList");
  list.replaceChildren();
  try {
    const snapshot = await getDocs(collection(db, "products"));
    snapshot.docs.forEach(productDocument => {
      const product = productDocument.data();
      const row = document.createElement("div");
      row.className = "admin-product-row";
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = product.name;
      const meta = document.createElement("small");
      meta.textContent = `${formatPrice(product.price)}・庫存 ${product.stock}・${product.active ? "上架" : "下架"}`;
      info.append(name, meta);
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "編輯";
      edit.addEventListener("click", () => fillProductForm(productDocument.id, product));
      row.append(info, edit);
      list.append(row);
    });
  } catch (error) {
    setMessage(byId("productMessage"), showFirebaseError(error), true);
  }
}

function fillProductForm(productId, product) {
  const form = byId("productForm");
  form.elements.productId.value = productId;
  form.elements.name.value = product.name || "";
  form.elements.category.value = product.category || "戒指";
  form.elements.material.value = product.material || "";
  form.elements.description.value = product.description || "";
  form.elements.price.value = product.price || "";
  form.elements.stock.value = product.stock || 0;
  form.elements.imageUrl.value = product.imageUrl || "";
  form.elements.imageFile.value = "";
  form.elements.active.value = String(product.active === true);
  form.querySelector(".commerce-submit").textContent = "儲存商品";
  byId("cancelProductEdit").hidden = false;
  adminDialog.querySelector(".commerce-panel").scrollTo({ top: 0, behavior: "smooth" });
}

async function handleCheckoutReturn(user) {
  const params = new URLSearchParams(window.location.search);
  const checkoutState = params.get("checkout");
  const orderId = params.get("order");
  if (checkoutState === "cancelled" && orderId && user) {
    try {
      await httpsCallable(functions, "cancelCheckoutSession")({ orderId });
      showToast("付款流程已取消，購物車商品仍為你保留。");
    } catch (error) {
      showToast(showFirebaseError(error));
    }
    params.delete("checkout");
    params.delete("order");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    return;
  }
  if (checkoutState === "success") {
    showToast("已收到付款返回資訊，訂單狀態以付款服務通知為準。");
    params.delete("checkout");
    params.delete("order");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    return true;
  }
  return false;
}

function startCartListener(user) {
  if (cartUnsubscribe) cartUnsubscribe();
  if (!user) {
    cartUnsubscribe = null;
    byId("cartCount").textContent = "0";
    byId("cartItems").innerHTML = '<p class="empty-state">登入後即可使用雲端購物車。</p>';
    byId("cartTotal").textContent = formatPrice(0);
    byId("checkoutButton").disabled = true;
    return;
  }
  cartUnsubscribe = onSnapshot(
    collection(db, "users", user.uid, "cart"),
    snapshot => renderCart(snapshot).catch(error => setMessage(byId("cartMessage"), showFirebaseError(error), true)),
    error => setMessage(byId("cartMessage"), showFirebaseError(error), true)
  );
}

async function initializeCommerce() {
  if (!isFirebaseConfigured) {
    productGrid.replaceChildren();
    const notice = document.createElement("p");
    notice.className = "empty-state";
    notice.textContent = "Firebase 尚未設定。請在 firebase-config.js 填入 Firebase Console 的 Web App 設定，再重新整理。";
    productGrid.append(notice);
    setMessage(productNotice, "目前未連接 Firebase；登入、商品、購物車及付款功能尚不可用。", true);
    byId("resultCount").textContent = "尚未連接商品資料";
    memberTrigger.addEventListener("click", () => {
      setMessage(byId("loginMessage"), "請先完成 Firebase 專案設定。", true);
      openDialog(memberDialog);
    });
    byId("cartTrigger").addEventListener("click", () => openDialog(cartDialog));
    return;
  }

  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  functions = getFunctions(app, "asia-east1");
  startProductListener();

  byId("cartTrigger").addEventListener("click", () => {
    setMessage(byId("cartMessage"), "");
    openDialog(cartDialog);
  });
  byId("search").addEventListener("input", applyProductFilters);
  document.querySelectorAll(".filter-btn").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach(filter => filter.classList.remove("active"));
      button.classList.add("active");
      activeFilter = button.dataset.filter;
      applyProductFilters();
    });
  });
  document.querySelectorAll("[data-filter-link]").forEach(link => {
    link.addEventListener("click", () => {
      activeFilter = link.dataset.filterLink;
      document.querySelectorAll(".filter-btn").forEach(button => button.classList.toggle("active", button.dataset.filter === activeFilter));
      applyProductFilters();
    });
  });
  byId("detailAdd").addEventListener("click", event => addToCart(event.currentTarget.dataset.productId));
  byId("checkoutButton").addEventListener("click", async () => {
    if (!currentUser) {
      openDialog(memberDialog);
      return;
    }
    const button = byId("checkoutButton");
    button.disabled = true;
    setMessage(byId("cartMessage"), "正在建立安全付款頁面…");
    try {
      const result = await httpsCallable(functions, "createCheckoutSession")();
      if (!result.data?.url || !result.data.url.startsWith("https://checkout.stripe.com/")) {
        throw new Error("付款服務回傳的網址無效。");
      }
      window.location.assign(result.data.url);
    } catch (error) {
      setMessage(byId("cartMessage"), showFirebaseError(error), true);
      button.disabled = false;
    }
  });

  byId("loginTab").addEventListener("click", () => setMemberTab("login"));
  byId("signupTab").addEventListener("click", () => setMemberTab("signup"));
  memberTrigger.addEventListener("click", () => {
    if (currentUser) {
      byId("memberProfile").hidden = false;
      byId("memberAuthView").hidden = true;
    } else {
      byId("memberAuthView").hidden = false;
      byId("memberProfile").hidden = true;
      setMemberTab("login");
    }
    openDialog(memberDialog);
  });
  byId("signupForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    const form = new FormData(event.currentTarget);
    try {
      const credential = await createUserWithEmailAndPassword(auth, String(form.get("email")).trim(), String(form.get("password")));
      const displayName = String(form.get("displayName")).trim();
      await updateProfile(credential.user, { displayName });
      await ensureProfile(credential.user, displayName);
      event.currentTarget.reset();
    } catch (error) {
      showMemberError(byId("signupMessage"), error);
    } finally {
      button.disabled = false;
    }
  });
  byId("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    const form = new FormData(event.currentTarget);
    try {
      await signInWithEmailAndPassword(auth, String(form.get("email")).trim(), String(form.get("password")));
      event.currentTarget.reset();
      setMessage(byId("loginMessage"), "");
    } catch (error) {
      showMemberError(byId("loginMessage"), error);
    } finally {
      button.disabled = false;
    }
  });
  byId("resetPassword").addEventListener("click", async () => {
    const email = byId("loginForm").elements.email.value.trim();
    if (!email) {
      setMessage(byId("loginMessage"), "請先輸入 Email，再寄送重設連結。", true);
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email);
      setMessage(byId("loginMessage"), "若此 Email 已註冊，密碼重設連結將寄送至信箱。");
    } catch (error) {
      showMemberError(byId("loginMessage"), error);
    }
  });
  byId("profileForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!currentUser) return;
    const form = new FormData(event.currentTarget);
    try {
      const displayName = String(form.get("displayName")).trim();
      await updateProfile(currentUser, { displayName });
      await updateDoc(doc(db, "users", currentUser.uid), {
        displayName,
        email: currentUser.email || "",
        phone: String(form.get("phone")).trim(),
        updatedAt: serverTimestamp()
      });
      memberTrigger.setAttribute("aria-label", `會員中心，${displayName}已登入`);
      setMessage(byId("profileMessage"), "會員資料已更新。");
    } catch (error) {
      showMemberError(byId("profileMessage"), error);
    }
  });
  byId("memberLogout").addEventListener("click", async () => {
    await signOut(auth);
    memberDialog.close();
    showToast("已安全登出。");
  });
  byId("viewOrders").addEventListener("click", () => currentUser && loadOrders(currentUser));
  byId("adminTrigger").addEventListener("click", async () => {
    if (!isAdmin) return;
    byId("productForm").reset();
    byId("productForm").elements.productId.value = "";
    byId("productForm").querySelector(".commerce-submit").textContent = "建立商品";
    byId("cancelProductEdit").hidden = true;
    setMessage(byId("productMessage"), "");
    openDialog(adminDialog);
    await loadAdminProducts();
  });
  byId("cancelProductEdit").addEventListener("click", () => {
    byId("productForm").reset();
    byId("productForm").elements.productId.value = "";
    byId("productForm").querySelector(".commerce-submit").textContent = "建立商品";
    byId("cancelProductEdit").hidden = true;
  });
  byId("productForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!isAdmin || !currentUser) return;
    const form = event.currentTarget;
    const submit = form.querySelector(".commerce-submit");
    submit.disabled = true;
    const values = new FormData(form);
    const imageFile = form.elements.imageFile.files[0];
    let imageUrl = String(values.get("imageUrl")).trim();
    if (imageFile && imageFile.size > 5 * 1024 * 1024) {
      setMessage(byId("productMessage"), "圖片不可超過 5 MB。", true);
      submit.disabled = false;
      return;
    }
    if (!imageFile && !imageUrl.startsWith("https://")) {
      setMessage(byId("productMessage"), "請上傳商品圖片，或提供 HTTPS 圖片網址。", true);
      submit.disabled = false;
      return;
    }
    const product = {
      name: String(values.get("name")).trim(),
      category: String(values.get("category")),
      material: String(values.get("material")).trim(),
      description: String(values.get("description")).trim(),
      price: Number(values.get("price")),
      stock: Number(values.get("stock")),
      imageUrl,
      active: values.get("active") === "true",
      updatedAt: serverTimestamp()
    };
    let uploadedImageReference = null;
    let imageUploaded = false;
    try {
      const productId = String(values.get("productId"));
      const reference = productId ? doc(db, "products", productId) : doc(collection(db, "products"));
      if (imageFile) {
        const extensions = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif"
        };
        const extension = extensions[imageFile.type];
        if (!extension) throw new Error("圖片格式僅支援 JPG、PNG、WebP 或 GIF。");
        uploadedImageReference = storageRef(storage, `products/${reference.id}/${crypto.randomUUID()}.${extension}`);
        await uploadBytes(uploadedImageReference, imageFile, { contentType: imageFile.type });
        imageUploaded = true;
        imageUrl = await getDownloadURL(uploadedImageReference);
      }
      product.imageUrl = imageUrl;
      if (!productId) product.createdAt = serverTimestamp();
      await setDoc(reference, product, { merge: Boolean(productId) });
      setMessage(byId("productMessage"), "商品資料已儲存。");
      form.reset();
      form.elements.productId.value = "";
      submit.textContent = "建立商品";
      byId("cancelProductEdit").hidden = true;
      await loadAdminProducts();
    } catch (error) {
      if (imageUploaded && uploadedImageReference) {
        try {
          await deleteObject(uploadedImageReference);
        } catch (cleanupError) {
          console.error("Uploaded product image cleanup failed", cleanupError);
        }
      }
      showMemberError(byId("productMessage"), error);
    } finally {
      submit.disabled = false;
    }
  });

  onAuthStateChanged(auth, async user => {
    currentUser = user;
    isAdmin = false;
    memberTrigger.setAttribute("aria-label", user ? `會員中心，${user.displayName || user.email}已登入` : "開啟會員中心");
    byId("memberProfile").hidden = true;
    byId("memberAuthView").hidden = Boolean(user);
    startCartListener(user);
    if (user) {
      await loadProfile(user);
      const pendingProductId = memberDialog.dataset.pendingProductId;
      const returnToCart = memberDialog.dataset.returnToCart === "true";
      if (returnToCart) {
        delete memberDialog.dataset.returnToCart;
        delete memberDialog.dataset.pendingProductId;
        memberDialog.close();
        if (pendingProductId) await addToCart(pendingProductId);
        showToast("登入成功，已為你保留剛才挑選的商品。");
      } else if (!memberDialog.open) {
        memberDialog.close();
      }
      const checkoutSucceeded = await handleCheckoutReturn(user);
      if (checkoutSucceeded) {
        await loadOrders(user);
        byId("memberProfile").hidden = false;
        byId("memberAuthView").hidden = true;
        openDialog(memberDialog);
      }
    } else {
      byId("adminTrigger").hidden = true;
      byId("memberStatus").textContent = "登入或建立帳號以開始購物。";
      byId("memberAuthView").hidden = false;
      memberTrigger.setAttribute("aria-label", "開啟會員中心");
      if (productUnsubscribe) productUnsubscribe();
      startProductListener();
      await handleCheckoutReturn(null);
    }
  });

  const recommendations = {
    "日常佩戴": "推薦方向：簡約戒指或輕巧項鍊，優先考慮舒適度與日常搭配。",
    "個性穿搭": "推薦方向：選擇輪廓鮮明的戒指，或用手鍊疊戴呈現個人風格。",
    "送禮心意": "推薦方向：先確認對方的日常風格與尺寸，再挑選寓意與包裝合適的作品。",
    "收藏欣賞": "推薦方向：仔細閱讀材質、處理方式、尺寸及可提供的鑑定資訊。"
  };
  document.querySelectorAll(".finder-option").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".finder-option").forEach(option => option.classList.remove("selected"));
      button.classList.add("selected");
      byId("finderResult").textContent = recommendations[button.dataset.choice];
    });
  });
  byId("menuBtn").addEventListener("click", () => {
    const menu = byId("mobileNav");
    const isOpen = menu.style.display === "flex";
    menu.style.display = isOpen ? "none" : "flex";
    byId("menuBtn").setAttribute("aria-expanded", String(!isOpen));
  });
  document.querySelectorAll("#mobileNav a").forEach(link => link.addEventListener("click", () => {
    byId("mobileNav").style.display = "none";
    byId("menuBtn").setAttribute("aria-expanded", "false");
  }));
  byId("newsletterForm").addEventListener("submit", event => {
    event.preventDefault();
    showToast("電子報功能尚未連接訂閱服務。");
    event.currentTarget.reset();
  });
}

if (isFirebaseConfigured) {
  initializeCommerce().catch(error => {
    console.error("Firebase initialization failed", error);
    setMessage(productNotice, "Firebase 初始化失敗，請確認專案設定與授權網域。", true);
  });
} else {
  productGrid.replaceChildren();
  const notice = document.createElement("p");
  notice.className = "empty-state";
  notice.textContent = "Firebase 尚未設定。請在 firebase-config.js 填入 Firebase Console 的 Web App 設定，再重新整理。";
  productGrid.append(notice);
  setMessage(productNotice, "目前未連接 Firebase；登入、商品、購物車及付款功能尚不可用。", true);
  byId("resultCount").textContent = "尚未連接商品資料";
  memberTrigger.addEventListener("click", () => {
    byId("memberAuthView").hidden = false;
    byId("memberProfile").hidden = true;
    setMessage(byId("loginMessage"), "請先完成 Firebase 專案設定。", true);
    openDialog(memberDialog);
  });
  byId("cartTrigger").addEventListener("click", () => openDialog(cartDialog));
  byId("search").addEventListener("input", () => {});
  document.querySelectorAll(".filter-btn").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(filter => filter.classList.toggle("active", filter === button));
  }));
  byId("checkoutButton").addEventListener("click", () => {
    setMessage(byId("cartMessage"), "請先完成 Firebase 專案與付款服務設定。", true);
  });
  byId("loginTab").addEventListener("click", () => setMemberTab("login"));
  byId("signupTab").addEventListener("click", () => setMemberTab("signup"));
  byId("signupForm").addEventListener("submit", event => {
    event.preventDefault();
    setMessage(byId("signupMessage"), "請先完成 Firebase 專案設定。", true);
  });
  byId("loginForm").addEventListener("submit", event => {
    event.preventDefault();
    setMessage(byId("loginMessage"), "請先完成 Firebase 專案設定。", true);
  });
  byId("resetPassword").addEventListener("click", () => {
    setMessage(byId("loginMessage"), "請先完成 Firebase 專案設定。", true);
  });
  byId("menuBtn").addEventListener("click", () => {
    const menu = byId("mobileNav");
    const isOpen = menu.style.display === "flex";
    menu.style.display = isOpen ? "none" : "flex";
    byId("menuBtn").setAttribute("aria-expanded", String(!isOpen));
  });
  document.querySelectorAll("#mobileNav a").forEach(link => link.addEventListener("click", () => {
    byId("mobileNav").style.display = "none";
    byId("menuBtn").setAttribute("aria-expanded", "false");
  }));
  const recommendations = {
    "日常佩戴": "推薦方向：簡約戒指或輕巧項鍊，優先考慮舒適度與日常搭配。",
    "個性穿搭": "推薦方向：選擇輪廓鮮明的戒指，或用手鍊疊戴呈現個人風格。",
    "送禮心意": "推薦方向：先確認對方的日常風格與尺寸，再挑選寓意與包裝合適的作品。",
    "收藏欣賞": "推薦方向：仔細閱讀材質、處理方式、尺寸及可提供的鑑定資訊。"
  };
  document.querySelectorAll(".finder-option").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll(".finder-option").forEach(option => option.classList.remove("selected"));
    button.classList.add("selected");
    byId("finderResult").textContent = recommendations[button.dataset.choice];
  }));
  byId("newsletterForm").addEventListener("submit", event => {
    event.preventDefault();
    showToast("電子報服務尚未連接。");
    event.currentTarget.reset();
  });
}
