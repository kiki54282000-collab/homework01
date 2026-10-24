# Jade Verse Firebase 商店

這是純 HTML、CSS、JavaScript 前端，使用 Firebase Authentication、Cloud Firestore、Cloud Storage、Firebase Hosting 和 Cloud Functions。付款由 Stripe Checkout 處理。`firebase-config.js` 目前已填入 Firebase Web App 設定；仍需在 Firebase Console 啟用服務並完成部署設定，付款也尚未啟用。

## 功能

- Email／密碼註冊、登入、登出及密碼重設。
- 會員姓名、電話維護與個人訂單紀錄。
- Firestore 商品即時瀏覽、分類篩選、搜尋及商品細節。
- 管理者上傳商品圖片至 Cloud Storage，或使用 HTTPS 圖片網址。
- 會員雲端購物車、數量修改及跨裝置同步。
- 管理者建立、編輯、上架或下架商品。
- Stripe Checkout 信用卡付款、Stripe 簽章 Webhook、付款狀態更新及庫存預留。

## 需求

- Node.js 20、npm、Firebase CLI。
- Firebase 專案已啟用 Authentication（Email/Password）、Cloud Firestore、Cloud Storage、Cloud Functions 和 Hosting。部署 Cloud Functions 通常需要 Firebase Blaze 計費方案；新建 Cloud Storage bucket 可能也需要 Blaze 方案。
- Stripe 帳號、測試／正式 API 金鑰與 Webhook Signing Secret。確認 Stripe 可在你的商家註冊地提供收款服務；若商家帳戶不能使用 Stripe，需改接當地可用的付款服務。

## Firebase 設定

1. Firebase Web App 設定已放在 `firebase-config.js`；若改用其他 Firebase 專案，請貼上該專案 Web App config。Web API Key 是前端設定值，不是伺服器秘密；不要把 Stripe 私密金鑰放在此檔。
2. Authentication > Sign-in method 啟用 Email/Password，並在 Authentication > Settings > Authorized domains 加入正式網域及本機測試網域。
3. 在 Firebase Console 建立 Firestore Database，並套用專案的 `firestore.rules`。
4. 在 Firebase Console 啟用 Cloud Storage，建立預設 bucket。商品圖片僅允許管理者上傳；Storage Rules 限制為 JPG、PNG、WebP、GIF 且不超過 5 MB。
5. 安裝 Firebase CLI，登入並選擇專案：

   ```powershell
   npm install -g firebase-tools
   firebase login
   firebase use --add
   ```

6. 從專案根目錄安裝 Functions 依賴：

   ```powershell
   npm install --prefix functions
   ```

7. 第一次部署 Hosting／Firestore／Storage 規則：

   ```powershell
   firebase deploy --only firestore:rules,storage,hosting
   ```

## 管理者與商品

1. 先透過網站註冊管理者帳號，在 Firebase Authentication 複製該帳號的 UID。
2. Firestore Console 建立文件 `admins/{UID}`，欄位為 `enabled`（boolean）=`true`。管理者清單不可由網站自行寫入。
3. 重新登入網站後，會員中心會出現「商品管理」。建立商品時使用新台幣整數價格、非負庫存，並上傳不超過 5 MB 的圖片或提供 HTTPS 圖片網址。
4. Firestore 的公開商品查詢只會回傳 `active == true` 的商品；管理介面下架會保留商品與歷史訂單資料。

商品文件欄位：

```text
products/{productId}
  name: string
  category: string
  description: string
  material: string
  price: integer (TWD)
  stock: integer
  reservedStock: integer (由付款 Functions 管理，不要手動編輯)
  imageUrl: HTTPS URL
  active: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
```

## Stripe 付款設定

1. 先完成 Firebase 專案與 Hosting 網域，設定 Functions 參數 `SITE_URL` 為網站根網址，例如 `https://your-project.web.app`。部署時若 CLI 詢問參數，填入實際網址；也可在 Functions 專案環境參數檔設定，切勿提交秘密金鑰。
2. 將 Stripe Secret Key 與 Webhook Signing Secret 分別存進 Firebase Secret Manager：

   ```powershell
   firebase functions:secrets:set STRIPE_SECRET_KEY
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
   ```

   CLI 會互動詢問秘密值；不要把秘密貼到聊天、原始碼或 Git。

3. 安裝依賴後部署付款 Functions：

   ```powershell
   npm install --prefix functions
   firebase deploy --only functions
   ```

4. 在 Stripe Dashboard 建立 Webhook Endpoint，URL 使用部署後的 `stripeWebhook` Functions URL。監聽 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed` 及 `checkout.session.expired`，再將顯示的 Signing Secret 設入 `STRIPE_WEBHOOK_SECRET`。
5. 先用 Stripe 測試金鑰完成測試付款、取消、逾時與庫存檢查，再切換正式金鑰及正式 Webhook Secret。

網站不接受瀏覽器提交的價格作為付款依據。Checkout Function 會從 Firestore 讀取商品與價格；Webhook 驗證簽章、Session、幣別與總額後更新訂單。訂單與付款狀態不可由會員瀏覽器寫入。

## 本機預覽與 Emulator

使用本機 HTTP 伺服器預覽頁面：

```powershell
python -m http.server 8000
```

目前 `firebase-config.js` 指向已設定的 Firebase 專案，因此本機預覽也會連到該專案；請勿用正式資料測試寫入。啟動 Emulator 本身不會讓前端自動連上 Emulator，需另外設定前端 Emulator 連線後再測試。

Firebase Emulator 可在安裝 CLI 後執行：

```powershell
firebase emulators:start
```

若要在 Emulator 測試 Email 登入、Firestore、Storage 和 Functions，還需設定本機 Emulator Suite、前端連線、測試資料及 Stripe 測試環境；上面的靜態 HTTP 伺服器不會模擬 Firebase 服務。

## 資料與安全界線

- Firebase Web App config 預期公開；Firestore Rules 與 Auth 是前端資料安全邊界。
- Stripe Secret Key、Webhook Secret 只由 Functions Secret Manager 讀取。
- 商品建立僅管理者可用；會員只能讀寫自己的個人資料及購物車，只能讀自己的訂單。
- Functions 對庫存做預留，付款成功後扣庫存，取消／失敗／逾時時釋放預留。仍應監控 Webhook 失敗與 `paid_inventory_review` 訂單，並定期核對 Stripe 與訂單資料。
- 會員資料、配送地址及付款須依實際營運地區補上隱私權政策、退換貨條款、客服與稅務資訊。

## 尚待專案擁有者完成設定

- Firebase Console 的 Auth、Firestore、Storage、管理者 UID 及計費設定。
- 商家可用的付款服務帳號、金鑰及正式 Webhook 設定。
- 正式商品資料、授權商品圖片、配送規則、退換貨政策與客服資訊。