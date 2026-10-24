const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const Stripe = require("stripe");

initializeApp();
const db = getFirestore();
const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const siteUrl = defineString("SITE_URL");
const checkoutLockMinutes = 35;

exports.createCheckoutSession = onCall(
  { region: "asia-east1", secrets: [stripeSecret], cors: true, maxInstances: 10 },
  async request => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "請先登入會員再結帳。");
    }

    const uid = request.auth.uid;
    const email = request.auth.token.email;
    if (!email) {
      throw new HttpsError("failed-precondition", "會員帳號沒有電子郵件地址。");
    }

    const cartRef = db.collection("users").doc(uid).collection("cart");
    const cartSnapshot = await cartRef.get();
    if (cartSnapshot.empty) {
      throw new HttpsError("failed-precondition", "購物車目前是空的。");
    }
    if (cartSnapshot.size > 100) {
      throw new HttpsError("failed-precondition", "購物車商品項目過多。");
    }

    const cartItems = cartSnapshot.docs.map(document => ({
      productId: document.id,
      quantity: document.data().quantity
    }));
    const productSnapshots = await Promise.all(
      cartItems.map(item => db.collection("products").doc(item.productId).get())
    );
    let products = productSnapshots.map((snapshot, index) => {
      const item = cartItems[index];
      const product = snapshot.data();
      if (!snapshot.exists || !product || product.active !== true) {
        throw new HttpsError("failed-precondition", "購物車中有已下架的商品，請重新整理購物車。");
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
        throw new HttpsError("invalid-argument", "商品數量不正確。");
      }
      if (!Number.isInteger(product.price) || product.price < 1) {
        throw new HttpsError("failed-precondition", "商品價格資料不正確。");
      }
      if (!Number.isInteger(product.stock) || product.stock - (product.reservedStock || 0) < item.quantity) {
        throw new HttpsError("failed-precondition", `${product.name} 庫存不足，請調整數量。`);
      }
      return { ...item, name: product.name, price: product.price, imageUrl: product.imageUrl || "" };
    });

    const orderRef = db.collection("users").doc(uid).collection("orders").doc();
    const lockRef = db.collection("users").doc(uid).collection("checkoutLocks").doc("active");
    const now = Date.now();
    const expiresAt = now + checkoutLockMinutes * 60 * 1000;
    await db.runTransaction(async transaction => {
      const productRefs = cartItems.map(item => db.collection("products").doc(item.productId));
      const cartRefs = cartItems.map(item => cartRef.doc(item.productId));
      const [lockSnapshot, ...itemSnapshots] = await Promise.all([
        transaction.get(lockRef),
        ...productRefs.map(reference => transaction.get(reference)),
        ...cartRefs.map(reference => transaction.get(reference))
      ]);
      const lock = lockSnapshot.data();
      if (lock && lock.expiresAt && lock.expiresAt.toMillis() > now) {
        throw new HttpsError("already-exists", "已有結帳程序進行中，請稍候或返回原結帳頁面。");
      }
      const reservedProducts = cartItems.map((item, index) => {
        const productSnapshot = itemSnapshots[index];
        const savedCartItem = itemSnapshots[cartItems.length + index];
        const product = productSnapshot.data();
        if (!savedCartItem.exists || savedCartItem.data().quantity !== item.quantity) {
          throw new HttpsError("aborted", "購物車已更新，請重新確認商品數量。");
        }
        if (!productSnapshot.exists || !product || product.active !== true) {
          throw new HttpsError("failed-precondition", "購物車中有已下架的商品，請重新整理購物車。");
        }
        const reservedStock = Number.isInteger(product.reservedStock) ? product.reservedStock : 0;
        if (!Number.isInteger(product.stock) || product.stock - reservedStock < item.quantity) {
          throw new HttpsError("failed-precondition", `${product.name} 庫存不足，請調整數量。`);
        }
        return { ...item, name: product.name, price: product.price, imageUrl: product.imageUrl || "", reservedStock };
      });
      products = reservedProducts;
      reservedProducts.forEach((product, index) => {
        transaction.update(productRefs[index], { reservedStock: product.reservedStock + product.quantity });
      });
      transaction.set(lockRef, {
        orderId: orderRef.id,
        expiresAt: Timestamp.fromMillis(expiresAt)
      });
      transaction.set(orderRef, {
        uid,
        email,
        status: "awaiting_payment",
        currency: "twd",
        items: products.map(({ productId, quantity, name, price }) => ({ productId, quantity, name, price })),
        total: products.reduce((sum, item) => sum + item.price * item.quantity, 0),
        createdAt: FieldValue.serverTimestamp()
      });
    });

    const baseUrl = siteUrl.value().replace(/\/$/, "");
    try {
      const stripe = new Stripe(stripeSecret.value());
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: email,
        phone_number_collection: { enabled: true },
        shipping_address_collection: { allowed_countries: ["TW"] },
        line_items: products.map(product => ({
          quantity: product.quantity,
          price_data: {
            currency: "twd",
            unit_amount: product.price,
            product_data: {
              name: product.name,
              ...(product.imageUrl.startsWith("https://") ? { images: [product.imageUrl] } : {})
            }
          }
        })),
        metadata: { uid, orderId: orderRef.id },
        expires_at: Math.floor(expiresAt / 1000),
        success_url: `${baseUrl}/?checkout=success&order=${orderRef.id}`,
        cancel_url: `${baseUrl}/?checkout=cancelled&order=${orderRef.id}`
      });
      await orderRef.update({ stripeSessionId: session.id });
      return { url: session.url };
    } catch (error) {
      await db.runTransaction(async transaction => {
        const orderSnapshot = await transaction.get(orderRef);
        const lockSnapshot = await transaction.get(lockRef);
        const orderItems = orderSnapshot.exists ? orderSnapshot.data().items || [] : [];
        const productRefs = orderItems.map(item => db.collection("products").doc(item.productId));
        const productSnapshots = await Promise.all(productRefs.map(reference => transaction.get(reference)));
        orderItems.forEach((item, index) => {
          if (!productSnapshots[index].exists) return;
          const product = productSnapshots[index].data();
          transaction.update(productRefs[index], {
            reservedStock: Math.max(0, (product.reservedStock || 0) - item.quantity),
            updatedAt: FieldValue.serverTimestamp()
          });
        });
        if (lockSnapshot.data()?.orderId === orderRef.id) transaction.delete(lockRef);
        if (orderSnapshot.exists) transaction.update(orderRef, { status: "checkout_error", errorAt: FieldValue.serverTimestamp() });
      });
      console.error("Stripe Checkout session creation failed", error);
      throw new HttpsError("internal", "目前無法建立付款頁面，請稍後再試。");
    }
  }
);

exports.cancelCheckoutSession = onCall(
  { region: "asia-east1", secrets: [stripeSecret], cors: true, maxInstances: 10 },
  async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入會員。");
    const orderId = request.data?.orderId;
    if (typeof orderId !== "string" || !/^[A-Za-z0-9]+$/.test(orderId)) {
      throw new HttpsError("invalid-argument", "結帳訂單編號不正確。");
    }

    const uid = request.auth.uid;
    const orderRef = db.collection("users").doc(uid).collection("orders").doc(orderId);
    const lockRef = db.collection("users").doc(uid).collection("checkoutLocks").doc("active");
    const orderSnapshot = await orderRef.get();
    if (!orderSnapshot.exists) return { cancelled: false };
    const order = orderSnapshot.data();
    if (order.status !== "awaiting_payment") return { cancelled: false };

    if (order.stripeSessionId) {
      try {
        const stripe = new Stripe(stripeSecret.value());
        const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        if (session.status === "open") await stripe.checkout.sessions.expire(session.id);
        if (session.payment_status === "paid" || session.status === "complete") return { cancelled: false };
      } catch (error) {
        if (error.type !== "StripeInvalidRequestError") throw error;
        const stripe = new Stripe(stripeSecret.value());
        const latestSession = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        if (latestSession.payment_status === "paid" || latestSession.status !== "expired") {
          return { cancelled: false };
        }
      }
    }

    await db.runTransaction(async transaction => {
      const currentOrder = await transaction.get(orderRef);
      const currentLock = await transaction.get(lockRef);
      if (!currentOrder.exists || currentOrder.data().status !== "awaiting_payment") return;
      const orderItems = currentOrder.data().items || [];
      const productRefs = orderItems.map(item => db.collection("products").doc(item.productId));
      const productSnapshots = await Promise.all(productRefs.map(reference => transaction.get(reference)));
      orderItems.forEach((item, index) => {
        if (!productSnapshots[index].exists) return;
        const product = productSnapshots[index].data();
        transaction.update(productRefs[index], {
          reservedStock: Math.max(0, (product.reservedStock || 0) - item.quantity),
          updatedAt: FieldValue.serverTimestamp()
        });
      });
      transaction.update(orderRef, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
      if (currentLock.data()?.orderId === orderId) transaction.delete(lockRef);
    });
    return { cancelled: true };
  }
);

exports.stripeWebhook = onRequest(
  { region: "asia-east1", secrets: [stripeSecret, stripeWebhookSecret], maxInstances: 10 },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).send("Method not allowed");
      return;
    }

    const stripe = new Stripe(stripeSecret.value());
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        request.rawBody,
        request.get("stripe-signature"),
        stripeWebhookSecret.value()
      );
    } catch (error) {
      console.warn("Invalid Stripe webhook signature", error.message);
      response.status(400).send("Invalid signature");
      return;
    }

    const session = event.data.object;
    const { uid, orderId } = session.metadata || {};
    if (!uid || !orderId) {
      response.status(200).send("Ignored: missing order metadata");
      return;
    }

    const orderRef = db.collection("users").doc(uid).collection("orders").doc(orderId);
    const lockRef = db.collection("users").doc(uid).collection("checkoutLocks").doc("active");
    const successEvent = event.type === "checkout.session.completed"
      || event.type === "checkout.session.async_payment_succeeded";
    const failedEvent = event.type === "checkout.session.async_payment_failed"
      || event.type === "checkout.session.expired";

    if (!successEvent && !failedEvent) {
      response.status(200).send("Event ignored");
      return;
    }
    if (successEvent && session.payment_status !== "paid") {
      response.status(200).send("Payment is not complete");
      return;
    }

    try {
      await db.runTransaction(async transaction => {
        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists) return;
        const order = orderSnapshot.data();
        if (order.status !== "awaiting_payment") return;
        if (session.id !== order.stripeSessionId) {
          throw new Error("Stripe session does not match the pending order.");
        }
        if (successEvent && (session.currency !== order.currency || session.amount_total !== order.total)) {
          throw new Error("Stripe payment amount does not match the order total.");
        }

        const lockSnapshot = await transaction.get(lockRef);
        const productRefs = order.items.map(item => db.collection("products").doc(item.productId));
        const cartRefs = successEvent
          ? order.items.map(item => db.collection("users").doc(uid).collection("cart").doc(item.productId))
          : [];
        const productSnapshots = await Promise.all(productRefs.map(reference => transaction.get(reference)));
        const cartSnapshots = successEvent
          ? await Promise.all(cartRefs.map(reference => transaction.get(reference)))
          : [];

        if (successEvent) {
          const inventoryAvailable = order.items.every((item, index) => {
            const product = productSnapshots[index].data();
            return product && Number.isInteger(product.stock) && product.stock >= item.quantity
              && (product.reservedStock || 0) >= item.quantity;
          });
          order.items.forEach((item, index) => {
            const product = productSnapshots[index].data();
            if (productSnapshots[index].exists) transaction.update(productRefs[index], {
              ...(inventoryAvailable ? { stock: product.stock - item.quantity } : {}),
              reservedStock: Math.max(0, (product.reservedStock || 0) - item.quantity),
              updatedAt: FieldValue.serverTimestamp()
            });
            const cartSnapshot = cartSnapshots[index];
            if (cartSnapshot.exists && cartSnapshot.data().quantity === item.quantity) {
              transaction.delete(cartRefs[index]);
            }
          });
          transaction.update(orderRef, {
            status: inventoryAvailable ? "paid" : "paid_inventory_review",
            paymentIntentId: session.payment_intent || null,
            shipping: (() => {
              const details = session.shipping_details || session.customer_details;
              const address = details?.address;
              return details ? {
                name: details.name || "",
                phone: details.phone || "",
                address: address ? {
                  line1: address.line1 || "",
                  line2: address.line2 || "",
                  city: address.city || "",
                  state: address.state || "",
                  postal_code: address.postal_code || "",
                  country: address.country || ""
                } : null
              } : null;
            })(),
            paidAt: FieldValue.serverTimestamp()
          });
        } else {
          order.items.forEach((item, index) => {
            if (!productSnapshots[index].exists) return;
            const product = productSnapshots[index].data();
            transaction.update(productRefs[index], {
              reservedStock: Math.max(0, (product.reservedStock || 0) - item.quantity),
              updatedAt: FieldValue.serverTimestamp()
            });
          });
          transaction.update(orderRef, {
            status: event.type === "checkout.session.expired" ? "expired" : "payment_failed",
            updatedAt: FieldValue.serverTimestamp()
          });
        }

        if (lockSnapshot.data()?.orderId === orderId) transaction.delete(lockRef);
      });
      response.status(200).send("Webhook handled");
    } catch (error) {
      console.error("Stripe webhook processing failed", error);
      response.status(500).send("Webhook processing failed");
    }
  }
);