# Voucher System API Documentation

## 概要

PCECommunityTokenV9に追加されたVoucherシステムは、Merkle Treeを使用したバウチャーコード配布機能を提供します。発行者はバウチャーキャンペーンを作成し、ユーザーは有効なコードとMerkle Proofを使ってトークンをクレームできます。

## セキュリティ設計

- **バウチャーコード**: 発行者のみが知る秘密情報（ダウンロードファイルで配布）
- **Merkle Root**: コントラクトに登録される公開情報（keccak256(code)のMerkle Tree）
- **クレーム**: ユーザーはコード + Merkle Proofを提出して検証

## コントラクトメソッド

### 1. registerVoucherIssuance

バウチャーキャンペーンを登録します。

```solidity
function registerVoucherIssuance(
    string memory issuanceId,
    string memory _name,
    uint256 _amountPerClaim,
    uint256 _countLimitPerUser,
    uint256 _totalAmountLimit,
    uint256 _initialFunds,
    uint256 _startTime,
    uint256 _endTime,
    bytes32 _merkleRoot
) external
```

**パラメータ**:
- `issuanceId`: キャンペーンの一意識別子（例: `voucher_1234567890_abc123`）
- `_name`: キャンペーン名（例: `campaign-2025-10-27-01-55`）
- `_amountPerClaim`: 1コードあたりのクレーム金額（displayBalance単位）
- `_countLimitPerUser`: 1ユーザーあたりのクレーム上限回数
- `_totalAmountLimit`: 全ユーザー合計のクレーム上限金額（displayBalance単位、0で無制限）
- `_initialFunds`: キャンペーンに預ける初期資金（displayBalance単位）
- `_startTime`: 開始時刻（Unixタイムスタンプ、0で即時開始）
- `_endTime`: 終了時刻（Unixタイムスタンプ、0で無期限）
- `_merkleRoot`: バウチャーコードのハッシュから生成されたMerkle Root

**使用例**:
```javascript
const codes = ["CODE-1234", "CODE-5678", "CODE-9012"];
const leaves = codes.map(code => ethers.keccak256(ethers.toUtf8Bytes(code)));
const merkleTree = buildMerkleTree(leaves);
const merkleRoot = merkleTree.root;

await communityToken.registerVoucherIssuance(
    "voucher_1234567890_abc",
    "Spring Campaign 2025",
    "100", // 100トークン/コード（displayBalance）
    1, // 1人1回まで
    "10000", // 最大合計10000トークンまで（0で無制限）
    "11000", // 初期資金: 10コード × 100 × 1.1（displayBalance）
    Math.floor(Date.now() / 1000), // 現在時刻
    Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30日後
    merkleRoot
);
```

**注意事項**:
- 発行者は`_initialFunds`分のトークンを持っている必要があります
- トークンはコントラクトに転送され、キャンペーン用にロックされます
- `_initialFunds`の推奨計算式: `コード数 × クレーム金額 × 1.1`
- すべての金額パラメータは displayBalance 単位で指定します（コントラクト内部で rawBalance に変換されます）

---

### 2. claimVoucher

バウチャーコードを使用してトークンをクレームします。

```solidity
function claimVoucher(
    string memory issuanceId,
    string memory code,
    bytes32[] memory proof
) external
```

**パラメータ**:
- `issuanceId`: キャンペーンID
- `code`: バウチャーコード（生の文字列）
- `proof`: Merkle Proof（keccak256(code)を証明するハッシュの配列）

**使用例**:
```javascript
const code = "CODE-1234";
const proof = generateMerkleProof(leaves, code);

await communityToken.claimVoucher(
    "voucher_1234567890_abc",
    code,
    proof
);
```

**検証ロジック**:
1. キャンペーンが有効か（`isActive == true`）
2. 現在時刻が開始〜終了時刻の範囲内か
3. ユーザーのクレーム回数が上限以下か（`claimLimitPerUser`）
4. 残高が十分か
5. 合計クレーム金額が上限以下か（`maxTotalClaimAmount`、0の場合は無制限）
6. Merkle Proofが正しいか（`MerkleProof.verify(proof, merkleRoot, keccak256(code))`）
7. コードが未使用か

**イベント**:
```solidity
event VoucherClaimed(
    string indexed issuanceId,
    address indexed claimer,
    string code,
    uint256 amount
);
```

---

### 2-2. claimVoucherWithAuthorization

メタトランザクション機能を使用してバウチャーコードでトークンをクレームします。EIP-712署名を使用することで、ガス代を別のアドレス（リレイヤー）が負担できます。

```solidity
function claimVoucherWithAuthorization(
    address claimer,
    string memory issuanceId,
    string memory code,
    bytes32[] calldata proof,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
) external
```

**パラメータ**:
- `claimer`: クレームするユーザーのアドレス（署名の所有者）
- `issuanceId`: キャンペーンID
- `code`: バウチャーコード（生の文字列）
- `proof`: Merkle Proof（keccak256(code)を証明するハッシュの配列）
- `validAfter`: 署名が有効になる時刻（Unixタイムスタンプ）
- `validBefore`: 署名が有効期限切れになる時刻（Unixタイムスタンプ）
- `nonce`: 一度だけ使用可能な一意の値（同じnonceは再利用不可）
- `v`, `r`, `s`: ECDSA署名のパラメータ

#### EIP-712署名方式（推奨）

MetaMask等のウォレットで`eth_signTypedData_v4`を使用する方式です。

**使用例（ethers.js v6）**:
```javascript
const claimer = await signer.getAddress();
const code = "CODE-1234";
const proof = generateMerkleProof(leaves, code);
const issuanceId = "voucher_1234567890_abc";

// 署名の有効期間を設定（例: 現在から1時間後まで有効）
const now = Math.floor(Date.now() / 1000);
const validAfter = now - 60; // 1分前（クロックスキュー対策）
const validBefore = now + 3600; // 1時間後

// 一意のnonceを生成（ランダムなbytes32）
const nonce = ethers.hexlify(ethers.randomBytes(32));

// トークン情報を取得
const tokenAddress = await communityToken.getAddress();
const tokenName = await communityToken.name();
const chainId = (await provider.getNetwork()).chainId;

// EIP-712 ドメイン定義
const domain = {
    name: tokenName,
    version: "1",
    chainId: chainId,
    verifyingContract: tokenAddress
};

// EIP-712 型定義
const types = {
    ClaimWithAuthorization: [
        { name: "claimer", type: "address" },
        { name: "issuanceId", type: "string" },
        { name: "code", type: "string" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
    ]
};

// 署名対象の値
const value = {
    claimer: claimer,
    issuanceId: issuanceId,
    code: code,
    validAfter: validAfter,
    validBefore: validBefore,
    nonce: nonce
};

// EIP-712署名を作成（ウォレットがeth_signTypedData_v4を呼び出す）
const signature = await signer.signTypedData(domain, types, value);
const sig = ethers.Signature.from(signature);

// claimVoucherWithAuthorizationを呼び出し（リレイヤーが実行）
await communityToken.claimVoucherWithAuthorization(
    claimer,
    issuanceId,
    code,
    proof,
    validAfter,
    validBefore,
    nonce,
    sig.v,
    sig.r,
    sig.s
);
```

#### 署名データをJSON形式で出力（リレイヤー連携用）

```javascript
const signatureData = {
    tokenAddress: tokenAddress,
    signature: {
        message: {
            claimer: claimer,
            issuanceId: issuanceId,
            code: code,
            proof: proof,
            validAfter: validAfter,
            validBefore: validBefore,
            nonce: nonce
        },
        r: sig.r,
        s: sig.s,
        v: "0x" + sig.v.toString(16)
    }
};
console.log(JSON.stringify(signatureData, null, 2));
```

**検証ロジック**:
1. `claimVoucher`と同じ検証（キャンペーン有効性、時刻範囲、クレーム上限など）
2. `validAfter`より後であること（`block.timestamp > validAfter`）
3. `validBefore`より前であること（`block.timestamp < validBefore`）
4. `nonce`が未使用であること
5. 署名が`claimer`のものであること（EIP-712形式で検証）
6. クレーム金額がメタトランザクション手数料より大きいこと

**メタトランザクション手数料**:
- クレーム金額から自動的にメタトランザクション手数料が差し引かれます
- 手数料は`msg.sender`（リレイヤー）に支払われます
- 残りの金額が`claimer`に転送されます
- 手数料は`getMetaTransactionFee()`で確認できます

**コントラクト側の署名検証ロジック**:
```solidity
bytes memory data = abi.encode(
    CLAIM_WITH_AUTHORIZATION_TYPEHASH,
    claimer,
    keccak256(bytes(issuanceId)),  // EIP-712: 文字列はkeccak256でハッシュ化
    keccak256(bytes(code)),         // EIP-712: 文字列はkeccak256でハッシュ化
    validAfter,
    validBefore,
    nonce
);
bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(data)));
require(ecrecover(digest, v, r, s) == claimer, "Invalid signature");
```

**イベント**:
```solidity
event VoucherClaimed(
    string indexed issuanceId,
    address indexed claimer,
    string code,
    uint256 amount
);

event AuthorizationUsed(
    address indexed account,
    bytes32 indexed nonce
);

event MetaTransactionFeeCollected(
    address indexed claimer,
    address indexed relayer,
    uint256 displayFee,
    uint256 rawFee
);
```

**注意事項**:
- `nonce`は一度使用すると再利用できません
- 署名の有効期間（`validAfter`〜`validBefore`）を適切に設定してください
- クレーム金額はメタトランザクション手数料より大きい必要があります
- リレイヤーは任意のアドレスで、ガス代を負担します
- EIP-712のドメイン定義（name, version, chainId, verifyingContract）はコントラクトと一致させる必要があります

---

### 3. canClaimVoucher

クレーム可否を事前チェックします（view関数）。

```solidity
function canClaimVoucher(
    string memory issuanceId,
    string memory code,
    bytes32[] calldata proof,
    address claimer
) external view returns (bool, uint8)
```

**パラメータ**:
- `issuanceId`: キャンペーンID
- `code`: バウチャーコード
- `proof`: Merkle Proof
- `claimer`: クレームするユーザーのアドレス

**戻り値**:
- `bool`: クレーム可能かどうか
- `uint8`: エラーコード（0の場合はエラーなし）

**エラーコード一覧**:
```javascript
ERROR_NONE = 0                  // エラーなし
ERROR_ISSUANCE_NOT_FOUND = 1    // キャンペーンが存在しない
ERROR_ISSUANCE_NOT_ACTIVE = 2   // キャンペーンが無効化されている
ERROR_NOT_STARTED = 3           // まだ開始していない
ERROR_ALREADY_ENDED = 4         // 既に終了している
ERROR_CLAIM_LIMIT_REACHED = 5   // ユーザーのクレーム上限到達
ERROR_INSUFFICIENT_FUNDS = 6    // 残高不足
ERROR_MAX_TOTAL_EXCEEDED = 7    // 合計クレーム上限到達
ERROR_INVALID_PROOF = 8         // Merkle Proofが無効
ERROR_CODE_ALREADY_USED = 9     // コードが既に使用済み
```

**使用例**:
```javascript
const code = "CODE-1234";
const proof = generateMerkleProof(leaves, code);
const claimer = await signer.getAddress();

const [canClaim, errorCode] = await communityToken.canClaimVoucher(
    "voucher_1234567890_abc",
    code,
    proof,
    claimer
);

if (canClaim) {
    console.log("Claim is possible!");
    // 実際のクレーム処理を実行
    await communityToken.claimVoucher("voucher_1234567890_abc", code, proof);
} else {
    console.error("Cannot claim. Error code:", errorCode);
    // エラーコードに応じた処理
    switch(errorCode) {
        case 1: console.error("Campaign not found"); break;
        case 2: console.error("Campaign is inactive"); break;
        case 3: console.error("Campaign not started yet"); break;
        case 4: console.error("Campaign already ended"); break;
        case 5: console.error("Claim limit reached"); break;
        case 6: console.error("Insufficient funds"); break;
        case 7: console.error("Max total claim amount exceeded"); break;
        case 8: console.error("Invalid Merkle proof"); break;
        case 9: console.error("Code already used"); break;
    }
}
```

**注意**: クレーム金額は自動的にキャンペーンの `claimAmountPerCode` が使用されるため、パラメータとして渡す必要はありません。

---

### 4. getVoucherIssuanceInfo

キャンペーン情報を取得します（残高情報を含む）。

```solidity
function getVoucherIssuanceInfo(string memory issuanceId)
    external
    view
    returns (
        string memory issuanceId,
        address owner,
        string memory name,
        uint256 amountPerClaim,
        uint256 countLimitPerUser,
        uint256 totalAmountLimit,
        uint256 startTime,
        uint256 endTime,
        bytes32 merkleRoot,
        bool isActive,
        uint256 remainingAmount,
        uint256 claimedAmount,
        uint256 claimedDisplayAmount,
        uint256 totalClaimCount
    )
```

**戻り値**:
- `issuanceId`: キャンペーンID
- `owner`: キャンペーンのオーナーアドレス
- `name`: キャンペーン名
- `amountPerClaim`: 1コードあたりのクレーム金額（displayBalance単位）
- `countLimitPerUser`: 1ユーザーあたりのクレーム上限回数
- `totalAmountLimit`: 全ユーザー合計のクレーム上限金額（displayBalance単位）
- `startTime`: 開始時刻（Unixタイムスタンプ）
- `endTime`: 終了時刻（Unixタイムスタンプ）
- `merkleRoot`: Merkle Root
- `isActive`: キャンペーンが有効かどうか
- `remainingAmount`: 残り資金（displayBalance単位）
- `claimedAmount`: クレーム済み金額（displayBalance単位）
- `claimedDisplayAmount`: クレーム済みの displayBalance 合計
- `totalClaimCount`: 総クレーム回数

**使用例**:
```javascript
const issuance = await communityToken.getVoucherIssuanceInfo("voucher_1234567890_abc");
console.log("Campaign name:", issuance.name);
console.log("Claim amount:", issuance.amountPerClaim.toString());
console.log("Total amount limit:", issuance.totalAmountLimit.toString());
console.log("Merkle root:", issuance.merkleRoot);
console.log("Active:", issuance.isActive);
console.log("Remaining amount:", issuance.remainingAmount.toString());
console.log("Claimed amount:", issuance.claimedAmount.toString());
console.log("Total claim count:", issuance.totalClaimCount.toString());
```

---

### 5. getVoucherIssuanceIds

すべてのキャンペーンIDを取得します。

```solidity
function getVoucherIssuanceIds() external view returns (string[] memory)
```

**使用例**:
```javascript
const ids = await communityToken.getVoucherIssuanceIds();
console.log("Total campaigns:", ids.length);

for (const id of ids) {
    const issuance = await communityToken.getVoucherIssuanceInfo(id);
    console.log(`${id}: ${issuance.name}`);
}
```

---

### 6. addVoucherFunds

キャンペーンに資金を追加します（オーナーのみ）。

```solidity
function addVoucherFunds(string memory issuanceId, uint256 amount) external
```

**パラメータ**:
- `issuanceId`: キャンペーンID
- `amount`: 追加する金額（displayBalance単位）

**使用例**:
```javascript
// 1000トークンを追加
await communityToken.addVoucherFunds("voucher_1234567890_abc", "1000");
```

**イベント**:
```solidity
event VoucherFundsAdded(string indexed issuanceId, uint256 rawAmount);
```

**注意**: パラメータは displayBalance 単位で指定しますが、イベントでは rawAmount が発行されます。

---

### 7. withdrawVoucherFunds

キャンペーンから資金を引き出します（オーナーのみ）。

```solidity
function withdrawVoucherFunds(string memory issuanceId, uint256 amount) external
```

**パラメータ**:
- `issuanceId`: キャンペーンID
- `amount`: 引き出す金額（displayBalance単位）

**使用例**:
```javascript
// 500トークンを引き出し
await communityToken.withdrawVoucherFunds("voucher_1234567890_abc", "500");
```

**制約**:
- 引き出し後も残高が0以上である必要があります

**イベント**:
```solidity
event VoucherFundsWithdrawn(string indexed issuanceId, uint256 rawAmount);
```

**注意**: パラメータは displayBalance 単位で指定しますが、イベントでは rawAmount が発行されます。

---

### 8. terminateVoucherIssuance

キャンペーンを終了します（オーナーのみ）。

```solidity
function terminateVoucherIssuance(string memory issuanceId) external
```

**使用例**:
```javascript
await communityToken.terminateVoucherIssuance("voucher_1234567890_abc");
```

**効果**:
- `isActive`が`false`になり、新規クレームができなくなります
- 既存の資金は残り、引き出し可能です

**イベント**:
```solidity
event VoucherIssuanceTerminated(string indexed issuanceId);
```

---

## Merkle Tree生成ガイド

### JavaScript実装例

```javascript
// 1. バウチャーコードを生成
const codes = [];
for (let i = 0; i < 100; i++) {
    codes.push(generateRandomCode()); // "ABCD-1234" 形式
}

// 2. コードをハッシュ化してleavesを作成
const leaves = codes.map(code => ethers.keccak256(ethers.toUtf8Bytes(code)));

// 3. Leavesをソート
const sortedLeaves = [...leaves].sort((a, b) => {
    return ethers.toBigInt(a) < ethers.toBigInt(b) ? -1 : 1;
});

// 4. Merkle Treeを構築
function buildMerkleTree(sortedLeaves) {
    let currentLevel = sortedLeaves;

    while (currentLevel.length > 1) {
        const nextLevel = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            if (i + 1 < currentLevel.length) {
                const left = currentLevel[i];
                const right = currentLevel[i + 1];
                const combined = ethers.toBigInt(left) < ethers.toBigInt(right)
                    ? ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [left, right])
                    : ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [right, left]);
                nextLevel.push(combined);
            } else {
                nextLevel.push(currentLevel[i]);
            }
        }
        currentLevel = nextLevel;
    }

    return { root: currentLevel[0] };
}

const merkleTree = buildMerkleTree(sortedLeaves);
const merkleRoot = merkleTree.root;

// 5. 各コードのProofを生成
function generateMerkleProof(leaves, code) {
    const hashedCode = ethers.keccak256(ethers.toUtf8Bytes(code));
    const sortedLeaves = [...leaves].sort((a, b) => {
        return ethers.toBigInt(a) < ethers.toBigInt(b) ? -1 : 1;
    });

    let index = sortedLeaves.indexOf(hashedCode);
    if (index === -1) return null;

    const proof = [];
    let currentLevel = sortedLeaves;

    while (currentLevel.length > 1) {
        const nextLevel = [];

        for (let i = 0; i < currentLevel.length; i += 2) {
            if (i === index) {
                if (i + 1 < currentLevel.length) {
                    proof.push(currentLevel[i + 1]);
                }
            } else if (i + 1 === index) {
                proof.push(currentLevel[i]);
            }

            if (i + 1 < currentLevel.length) {
                const left = currentLevel[i];
                const right = currentLevel[i + 1];
                const combined = ethers.toBigInt(left) < ethers.toBigInt(right)
                    ? ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [left, right])
                    : ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [right, left]);
                nextLevel.push(combined);
            } else {
                nextLevel.push(currentLevel[i]);
            }
        }

        currentLevel = nextLevel;
        index = Math.floor(index / 2);
    }

    return proof;
}

// 6. コードとProofをユーザーに配布
const codeWithProof = codes.map(code => ({
    code: code,
    proof: generateMerkleProof(leaves, code)
}));
```

---

## セキュリティのベストプラクティス

### 発行者側

1. **コードの保管**
   - 生のコードリストは安全な場所に保管（暗号化推奨）
   - LocalStorageには**ハッシュ化されたコード（leaves）のみ**を保存
   - バックアップを取得（ダウンロード機能を使用）

2. **初期資金の計算**
   ```javascript
   initialFunds = コード数 × (クレーム金額 + メタトランザクション手数料) × 1.1
   ```
   - 1.1倍の余裕を持たせることを推奨

3. **期間設定**
   - 適切な開始・終了時刻を設定
   - テストキャンペーンで動作確認後、本番実施

### ユーザー側

1. **コードの取り扱い**
   - バウチャーコードは1回のみ使用可能
   - 第三者に共有しない

2. **クレーム前の確認**
   - キャンペーンが有効か（`isActive == true`）
   - 現在時刻が有効期間内か
   - 自分のクレーム回数が上限以下か

---

## トラブルシューティング

### よくあるエラー

1. **"Issuance not found"**
   - 存在しないissuanceIdを指定している
   - `getVoucherIssuanceIds()`で有効なIDを確認

2. **"Invalid Merkle proof"**
   - コードが間違っている
   - Proofが正しく生成されていない
   - キャンペーンのMerkle Rootと一致していない

3. **"Code already used"**
   - そのコードは既に使用済み
   - 各コードは1回のみ使用可能

4. **"Claim limit exceeded"**
   - ユーザーのクレーム回数が上限に達している
   - `claimLimitPerUser`を確認

5. **"Insufficient remaining balance"**
   - キャンペーンの残高不足
   - `addVoucherFunds()`で資金を追加

6. **"Not started yet" / "Already ended"**
   - キャンペーンの有効期間外
   - `startTime`と`endTime`を確認

---

## イベント一覧

```solidity
event VoucherIssuanceRegistered(
    string issuanceId,
    address indexed owner,
    string name,
    uint256 amountPerClaim,
    uint256 countLimitPerUser,
    uint256 totalAmountLimit,
    uint256 initialFundsRawAmount,
    uint256 startTime,
    uint256 endTime,
    bytes32 merkleRoot
);

event VoucherClaimed(
    string indexed issuanceId,
    address indexed claimer,
    string code,
    uint256 amount
);

event VoucherFundsAdded(
    string indexed issuanceId,
    uint256 rawAmount
);

event VoucherFundsWithdrawn(
    string indexed issuanceId,
    uint256 rawAmount
);

event VoucherIssuanceTerminated(
    string indexed issuanceId
);
```

**注意**:
- VoucherIssuanceRegistered イベントには `totalAmountLimit` フィールドが含まれます
- `amountPerClaim` と `totalAmountLimit` は displayBalance 単位、`initialFundsRawAmount` は rawAmount 単位です

---

## まとめ

Voucherシステムを使用することで、以下が実現できます：

- ✅ 安全なバウチャーコード配布（Merkle Proof）
- ✅ オンチェーンでの検証（コントラクトでMerkle Rootを検証）
- ✅ 柔軟なキャンペーン管理（資金追加・引き出し・終了）
- ✅ ユーザー毎のクレーム制限
- ✅ 期間限定キャンペーン

発行者は生のコードを安全に管理し、ユーザーにはコードのみを配布します。オンチェーンではMerkle Proofで検証するため、すべてのコードをコントラクトに保存する必要がなく、ガス効率が良い設計となっています。
