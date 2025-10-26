# PCE Voucher System Demo

PCECommunityTokenV9のvoucherシステムをテストするためのデモアプリケーションです。

## 機能

### 1. Register Issuance (発行登録)
新しいvoucher発行キャンペーンを登録します。
- Issuance ID: キャンペーンの一意なID
- Name: キャンペーン名
- Claim Amount Per Code: 1コードあたりの請求可能な金額
- Claim Limit Per User: ユーザーあたりの請求制限回数
- Total Issued Amount: 総発行額
- Start/End Time: キャンペーン期間（Unix timestamp）
- Merkle Root: コード検証用のMerkle root

### 2. Claim Voucher (バウチャー請求)
バウチャーコードを使用してトークンを請求します。
- Issuance ID: キャンペーンID
- Voucher Code: 配布されたコード
- Merkle Proof: LocalStorageから自動的に読み込まれます

### 3. Manage Proofs (証明管理)
Merkle proofのデータを管理します。
- Proof Leaves: コードリストをJSON配列で保存
- LocalStorageに保存されるため、ブラウザを閉じても保持されます

## セットアップ

### 1. コミュニティトークンの追加

`app.js`の`NETWORKS`設定にコミュニティトークンのアドレスを追加します：

```javascript
const NETWORKS = {
    'mainnet-prd': {
        name: 'Mainnet Production',
        pceToken: '0xA4807a8C34353A5EA51aF073175950Cb6248dA7E',
        pceSymbol: 'PCE',
        communityTokens: [
            { address: '0xYourCommunityTokenAddress', name: 'Your Token', symbol: 'YT' }
        ]
    },
    // ...
};
```

### 2. ローカルサーバーの起動

```bash
cd /path/to/web
python3 -m http.server 8000
```

ブラウザで http://localhost:8000/voucher/ にアクセス

### 3. ウォレット接続

1. MetaMaskをインストール
2. "Connect Wallet"をクリック
3. コミュニティトークンを選択

## 使用方法

### Voucher発行の流れ

1. **コードリストの準備**
   - "Manage Proofs"タブで、コードのリストをJSON配列で入力
   - 例: `["CODE001", "CODE002", "CODE003"]`
   - "Save Proofs to LocalStorage"をクリック
   - Merkle Rootが表示されます

2. **発行登録**
   - "Register Issuance"タブに移動
   - 必要な情報を入力（Merkle Rootは手順1で表示されたものを使用）
   - "Register Voucher Issuance"をクリック

3. **コード配布**
   - 保存したコードをユーザーに配布

### Voucherの請求

1. **Proofの読み込み**
   - "Claim Voucher"タブに移動
   - Issuance IDを入力
   - "Load Proof from Storage"をクリック

2. **請求**
   - Voucher Codeを入力
   - "Claim Voucher"をクリック

## 技術仕様

### Merkle Tree実装

- ハッシュ関数: keccak256
- ソート: 兄弟ノードは小さい値を左に配置
- Leaf: keccak256(code)

### LocalStorage

- キー形式: `voucher_proofs_{issuanceId}`
- 値: JSON配列形式のコードリスト

### 対応ネットワーク

- Mainnet Production
- Mainnet Dev

## トラブルシューティング

### "No community tokens found"が表示される

- `app.js`の`NETWORKS`設定にコミュニティトークンを追加してください
- または、PCETokenコントラクトに`getTokens()`でトークンが登録されているか確認してください

### "Failed to load community tokens"エラー

- PCETokenのアドレスが正しいか確認してください
- ネットワークが正しく選択されているか確認してください

### トランザクションが失敗する

- コミュニティトークンのownerとしてログインしているか確認
- Merkle Rootが正しいか確認
- コードがMerkle treeに含まれているか確認
