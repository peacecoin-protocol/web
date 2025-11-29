import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.15.0/ethers.min.js";

// Configuration
const NETWORKS = {
    'mainnet-prd': {
        name: 'Mainnet Production',
        pceToken: '0xA4807a8C34353A5EA51aF073175950Cb6248dA7E',
        pceSymbol: 'PCE',
        communityTokens: [
            // Add your community token addresses here
            // Example: { address: '0x...', name: 'Community Token 1', symbol: 'CT1' }
        ]
    },
    'mainnet-dev': {
        name: 'Mainnet Dev',
        pceToken: '0x62Ef93EAa5bB3E47E0e855C323ef156c8E3D8913',
        pceSymbol: 'DPCE',
        communityTokens: [
            // Add your community token addresses here
            // Example: { address: '0x...', name: 'Dev Community Token 1', symbol: 'DCT1' }
        ]
    }
};

let currentNetwork = 'mainnet-prd';
let PCE_TOKEN_ADDRESS = NETWORKS[currentNetwork].pceToken;

// ABIs
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function name() view returns (string)",
    "function symbol() view returns (string)"
];

const PCE_TOKEN_ABI = [
    ...ERC20_ABI,
    "function getTokens() view returns (address[])"
];

const VOUCHER_ABI = [
    ...ERC20_ABI,
    "function registerVoucherIssuance(string issuanceId, string _name, uint256 _amountPerClaim, uint256 _countLimitPerUser, uint256 _totalAmountLimit, uint256 _initialFunds, uint256 _startTime, uint256 _endTime, bytes32 _merkleRoot, string _ipfsCid)",
    "function claimVoucher(string issuanceId, string code, bytes32[] proof)",
    "function claimVoucherWithAuthorization(address claimer, string issuanceId, string code, bytes32[] proof, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
    "function canClaimVoucher(string issuanceId, string code, bytes32[] proof, address claimer) view returns (bool, uint8)",
    "function getVoucherIssuanceInfo(string issuanceId) view returns (tuple(string issuanceId, address owner, string name, uint256 amountPerClaim, uint256 countLimitPerUser, uint256 totalAmountLimit, uint256 startTime, uint256 endTime, bytes32 merkleRoot, bool isActive, uint256 remainingAmount, uint256 claimedAmount, uint256 claimedDisplayAmount, uint256 totalClaimCount, string ipfsCid))",
    "function getVoucherIssuanceIds() view returns (string[])",
    "function addVoucherFunds(string issuanceId, uint256 amount)",
    "function withdrawVoucherFunds(string issuanceId, uint256 amount)",
    "function terminateVoucherIssuance(string issuanceId)",
    "function getMetaTransactionFee() view returns (uint256)",
    "function DOMAIN_SEPARATOR() view returns (bytes32)",
    "function CLAIM_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
    "function owner() view returns (address)"
];

// Default TYPEHASH (can be fetched from contract)
const DEFAULT_CLAIM_WITH_AUTHORIZATION_TYPEHASH = "0x7e6c8f6b45c0f4e8c8c0e6c7c8b9a0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7";

// Voucher Store API (IPFS-backed storage)
const VOUCHER_STORE_API = "https://voucher-store.peace-coin.org";

let provider, signer, pceToken, selectedCommunityToken;
let currentProof = null;
let generatedCodes = null;
let generatedMerkleRoot = null;
let generatedIssuanceId = null;

// LocalStorage key prefix with version (for token cache only)
const CACHE_VERSION = 'v2';
const TOKENS_CACHE_PREFIX = `voucher_tokens_cache_${CACHE_VERSION}_`;

// Clean up old cache versions
function cleanupOldCache() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('voucher_tokens_cache_') && !key.startsWith(TOKENS_CACHE_PREFIX)) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    if (keysToRemove.length > 0) {
        console.log(`Cleaned up ${keysToRemove.length} old cache entries`);
    }
}

// IPFS Storage Functions (via pce-voucher-store API)
async function uploadLeavesToIPFS(leaves) {
    try {
        const response = await fetch(`${VOUCHER_STORE_API}/api/leaves`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(leaves)
        });

        if (!response.ok) {
            throw new Error(`Failed to upload to IPFS: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Uploaded leaves to IPFS, CID:', data.cid);
        return data.cid;
    } catch (error) {
        console.error('Failed to upload leaves to IPFS:', error);
        throw error;
    }
}

async function fetchLeavesFromIPFS(cid) {
    try {
        const response = await fetch(`${VOUCHER_STORE_API}/api/leaves?cid=${encodeURIComponent(cid)}`);

        if (!response.ok) {
            throw new Error(`Failed to fetch from IPFS: ${response.statusText}`);
        }

        const leaves = await response.json();
        console.log('Fetched leaves from IPFS, count:', leaves.length);
        return leaves;
    } catch (error) {
        console.error('Failed to fetch leaves from IPFS:', error);
        throw error;
    }
}

// Get leaves from IPFS
async function getLeaves(ipfsCid) {
    if (!ipfsCid) {
        return null;
    }
    return await fetchLeavesFromIPFS(ipfsCid);
}

async function connectWallet() {
    try {
        if (typeof window.ethereum === 'undefined') {
            showError('Please install MetaMask to use this app');
            return;
        }

        await window.ethereum.request({ method: 'eth_requestAccounts' });
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();

        const address = await signer.getAddress();
        document.getElementById('wallet-address').textContent = address.substring(0, 6) + '...' + address.substring(38);

        // Initialize PCE Token contract
        pceToken = new ethers.Contract(PCE_TOKEN_ADDRESS, PCE_TOKEN_ABI, signer);

        // Update UI
        document.getElementById('connect-wallet').style.display = 'none';
        document.getElementById('wallet-info').style.display = 'block';
        document.getElementById('token-selector-section').style.display = 'block';

        // Load balance
        await updateBalance();

        // Load community tokens
        await loadCommunityTokens();

        // Listen for account changes
        window.ethereum.on('accountsChanged', connectWallet);

    } catch (error) {
        showError('Failed to connect wallet: ' + error.message);
    }
}

async function loadCommunityTokens() {
    try {
        showMessage('Loading community tokens...');

        const select = document.getElementById('community-token-select');
        const cacheKey = TOKENS_CACHE_PREFIX + currentNetwork;

        // Load from cache first
        const cachedData = localStorage.getItem(cacheKey);
        let cachedTokens = [];
        if (cachedData) {
            try {
                cachedTokens = JSON.parse(cachedData);
                // Display cached tokens immediately
                select.innerHTML = '<option value="">-- Select a token --</option>';
                for (const token of cachedTokens) {
                    const option = document.createElement('option');
                    option.value = token.address;
                    option.textContent = `${token.name} (${token.symbol})`;
                    select.appendChild(option);
                }
                showMessage(`Loaded ${cachedTokens.length} token(s) from cache, checking for updates...`);
            } catch (error) {
                console.error('Failed to parse cached tokens:', error);
            }
        }

        let tokenAddresses = [];

        // Always fetch from contract to detect new tokens
        try {
            tokenAddresses = await pceToken.getTokens();
        } catch (error) {
            console.log('Could not fetch tokens from contract, using manual configuration');
        }

        // If no tokens from contract, use manual configuration
        if (tokenAddresses.length === 0 && NETWORKS[currentNetwork].communityTokens.length > 0) {
            select.innerHTML = '<option value="">-- Select a token --</option>';
            for (const token of NETWORKS[currentNetwork].communityTokens) {
                const option = document.createElement('option');
                option.value = token.address;
                option.textContent = `${token.name} (${token.symbol})`;
                select.appendChild(option);
            }
            showMessage(`Loaded ${NETWORKS[currentNetwork].communityTokens.length} community token(s) from configuration`);
            return;
        }

        // Load token info for each address from contract
        const tokens = [];
        for (const tokenAddress of tokenAddresses) {
            try {
                const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
                const name = await tokenContract.name();
                const symbol = await tokenContract.symbol();

                tokens.push({ address: tokenAddress, name, symbol });
            } catch (error) {
                console.error(`Failed to load token ${tokenAddress}:`, error);
            }
        }

        // Save to cache
        if (tokens.length > 0) {
            localStorage.setItem(cacheKey, JSON.stringify(tokens));

            // Update UI only if different from cache
            const tokensChanged = JSON.stringify(tokens) !== JSON.stringify(cachedTokens);
            if (tokensChanged || !cachedData) {
                select.innerHTML = '<option value="">-- Select a token --</option>';
                for (const token of tokens) {
                    const option = document.createElement('option');
                    option.value = token.address;
                    option.textContent = `${token.name} (${token.symbol})`;
                    select.appendChild(option);
                }

                if (tokens.length > cachedTokens.length) {
                    showSuccess(`Found ${tokens.length - cachedTokens.length} new token(s)! Total: ${tokens.length}`);
                } else {
                    showMessage(`Loaded ${tokens.length} community token(s)`);
                }
            } else {
                showMessage(`${tokens.length} token(s) loaded (up to date)`);
            }
        } else if (tokenAddresses.length === 0 && !cachedData) {
            showMessage('No community tokens found. Please add token addresses to the configuration.');
        }

    } catch (error) {
        showError('Failed to load community tokens: ' + error.message);
    }
}

async function updateBalance() {
    try {
        const address = await signer.getAddress();
        const balance = await pceToken.balanceOf(address);
        const decimals = await pceToken.decimals();

        document.getElementById('pce-balance').textContent = ethers.formatUnits(balance, decimals);
    } catch (error) {
        console.error('Failed to update balance:', error);
    }
}

async function calculateInitialFunds() {
    try {
        if (!selectedCommunityToken) return;

        const codeCount = parseFloat(document.getElementById('code-count').value) || 0;
        const claimAmount = parseFloat(document.getElementById('claim-amount').value) || 0;

        if (codeCount <= 0 || claimAmount <= 0) {
            document.getElementById('initial-funds').value = '';
            return;
        }

        // Get meta transaction fee
        const metaFee = await selectedCommunityToken.getMetaTransactionFee();
        const decimals = await selectedCommunityToken.decimals();
        const metaFeeFormatted = parseFloat(ethers.formatUnits(metaFee, decimals));

        // Calculate: count * (peramount + metafee) * 1.1
        const initialFunds = codeCount * (claimAmount + metaFeeFormatted) * 1.1;
        document.getElementById('initial-funds').value = initialFunds.toFixed(6);

    } catch (error) {
        console.error('Failed to calculate initial funds:', error);
    }
}

async function setDefaultFormValues() {
    // Generate default campaign name with timestamp
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const defaultName = `campaign-${year}-${month}-${day}-${hours}-${minutes}`;
    document.getElementById('issuance-name').value = defaultName;

    // Set default values
    document.getElementById('code-count').value = '10';
    document.getElementById('claim-amount').value = '100';
    document.getElementById('claim-limit').value = '1';

    // Set start time to now
    const formatDateTime = (date) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        const s = String(date.getSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${h}:${min}:${s}`;
    };

    document.getElementById('start-time').value = formatDateTime(now);

    // Set end time to 30 days from now
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    document.getElementById('end-time').value = formatDateTime(endDate);

    // Calculate initial funds
    await calculateInitialFunds();
}

async function onCommunityTokenSelected() {
    try {
        const select = document.getElementById('community-token-select');
        const tokenAddress = select.value;

        if (!tokenAddress) {
            document.getElementById('token-info').style.display = 'none';
            document.getElementById('main-section').style.display = 'none';
            selectedCommunityToken = null;
            return;
        }

        // Initialize selected community token contract
        selectedCommunityToken = new ethers.Contract(tokenAddress, VOUCHER_ABI, signer);

        // Get token info
        const name = await selectedCommunityToken.name();
        const symbol = await selectedCommunityToken.symbol();
        const address = await signer.getAddress();
        const balance = await selectedCommunityToken.balanceOf(address);
        const decimals = await selectedCommunityToken.decimals();
        const metaFee = await selectedCommunityToken.getMetaTransactionFee();

        // Update UI
        document.getElementById('selected-token-name').textContent = name;
        document.getElementById('selected-token-symbol').textContent = symbol;
        document.getElementById('selected-token-balance').textContent = ethers.formatUnits(balance, decimals);
        document.getElementById('selected-token-metafee').textContent = ethers.formatUnits(metaFee, decimals);
        document.getElementById('token-info').style.display = 'block';
        document.getElementById('main-section').style.display = 'block';

        // Set default form values
        setDefaultFormValues();

        showSuccess(`Selected ${name} (${symbol})`);

    } catch (error) {
        showError('Failed to load token info: ' + error.message);
    }
}

function generateIssuanceId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `voucher_${timestamp}_${random}`;
}

function generateRandomCode() {
    return Array.from({length: 16}, () => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 36)]).join('');
}

function generateCodes(count) {
    const codes = [];
    while (codes.length < count) {
        const code = generateRandomCode();
        if (!codes.includes(code)) {
            codes.push(code);
        }
    }
    return codes;
}

function generateMerkleTree(codes) {
    // Hash all codes to create leaves (keccak256(code))
    // codes: raw code strings (kept secret by issuer)
    // leaves: hashed codes (used to build Merkle tree)
    const leaves = codes.map(code => ethers.keccak256(ethers.toUtf8Bytes(code)));

    // Sort leaves
    let currentLevel = [...leaves].sort((a, b) => {
        return ethers.toBigInt(a) < ethers.toBigInt(b) ? -1 : 1;
    });

    // Build tree
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

    const root = currentLevel[0];

    return {
        root,
        leaves: codes
    };
}

async function onGenerateCodesAndMerkleRoot() {
    try {
        const codeCount = parseInt(document.getElementById('code-count').value);
        const claimAmount = parseFloat(document.getElementById('claim-amount').value);

        if (!codeCount || codeCount <= 0) {
            showError('Please enter a valid number of codes');
            return;
        }

        if (!claimAmount || claimAmount <= 0) {
            showError('Please enter a valid claim amount');
            return;
        }

        showMessage('Generating issuance ID, codes, and Merkle root...');

        // Generate issuance ID
        generatedIssuanceId = generateIssuanceId();

        // Generate codes
        generatedCodes = generateCodes(codeCount);

        // Generate Merkle tree
        const merkleTree = generateMerkleTree(generatedCodes);
        generatedMerkleRoot = merkleTree.root;

        // Show codes preview with issuance ID
        const previewDiv = document.getElementById('codes-preview');
        previewDiv.innerHTML = `
            <p><strong>Issuance ID:</strong> ${generatedIssuanceId}</p>
            <p><strong>Merkle Root:</strong> ${generatedMerkleRoot}</p>
            <p><strong>Codes:</strong></p>
            <pre>${generatedCodes.slice(0, 10).join('\n')}${generatedCodes.length > 10 ? '\n... and ' + (generatedCodes.length - 10) + ' more codes' : ''}</pre>
        `;
        document.getElementById('generated-codes-info').style.display = 'block';

        showSuccess(`Generated issuance ID, ${codeCount} codes, and Merkle root`);

    } catch (error) {
        showError('Failed to generate: ' + error.message);
    }
}

function downloadCodes() {
    if (!generatedCodes || !generatedIssuanceId) {
        showError('No codes generated yet');
        return;
    }

    const content = generatedCodes.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voucher_codes_${generatedIssuanceId}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showSuccess('Codes downloaded');
}

function parseDateTime(dateTimeStr) {
    if (!dateTimeStr || dateTimeStr.trim() === '') {
        return 0;
    }

    try {
        // Parse YYYY-MM-DD HH:MM:SS format
        const match = dateTimeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
        if (!match) {
            throw new Error('Invalid format. Use YYYY-MM-DD HH:MM:SS');
        }

        const [, year, month, day, hour, minute, second] = match;
        const date = new Date(
            parseInt(year),
            parseInt(month) - 1, // Month is 0-indexed
            parseInt(day),
            parseInt(hour),
            parseInt(minute),
            parseInt(second)
        );

        if (isNaN(date.getTime())) {
            throw new Error('Invalid date/time values');
        }

        return Math.floor(date.getTime() / 1000);
    } catch (error) {
        throw new Error(`Failed to parse date/time "${dateTimeStr}": ${error.message}`);
    }
}

async function registerVoucherIssuance() {
    try {
        if (!selectedCommunityToken) {
            showError('Please select a community token first');
            return;
        }

        if (!generatedCodes || !generatedMerkleRoot || !generatedIssuanceId) {
            showError('Please generate codes first by clicking "Generate Codes & Merkle Root"');
            return;
        }

        const name = document.getElementById('issuance-name').value;
        const claimAmount = document.getElementById('claim-amount').value;
        const claimLimit = document.getElementById('claim-limit').value;
        const maxTotalClaim = document.getElementById('max-total-claim').value || '0';
        const initialFunds = document.getElementById('initial-funds').value;
        const startTimeStr = document.getElementById('start-time').value;
        const endTimeStr = document.getElementById('end-time').value;

        if (!name || !claimAmount || !claimLimit || !initialFunds) {
            showError('Please fill all required fields');
            return;
        }

        // Parse date/time strings
        let startTime, endTime;
        try {
            startTime = parseDateTime(startTimeStr);
            endTime = parseDateTime(endTimeStr);
        } catch (error) {
            showError(error.message);
            return;
        }

        // Get decimals and convert to Wei (displayBalance unit)
        const decimals = await selectedCommunityToken.decimals();
        const claimAmountWei = ethers.parseUnits(claimAmount, decimals);
        const maxTotalClaimWei = maxTotalClaim === '' || maxTotalClaim === '0'
            ? 0n
            : ethers.parseUnits(maxTotalClaim, decimals);
        const initialFundsWei = ethers.parseUnits(initialFunds, decimals);

        // Upload leaves to IPFS first
        showMessage('Uploading leaves to IPFS...');
        const leaves = generatedCodes.map(code => ethers.keccak256(ethers.toUtf8Bytes(code)));
        let ipfsCid = '';
        try {
            ipfsCid = await uploadLeavesToIPFS(leaves);
            showMessage(`Leaves uploaded to IPFS (CID: ${ipfsCid.substring(0, 16)}...)`);
        } catch (error) {
            console.error('Failed to upload to IPFS, continuing without CID:', error);
            showMessage('Warning: Failed to upload to IPFS, continuing without CID...');
        }

        showMessage('Registering voucher issuance on blockchain...');

        try {
            const tx = await selectedCommunityToken.registerVoucherIssuance(
                generatedIssuanceId,
                name,
                claimAmountWei,
                claimLimit,
                maxTotalClaimWei,
                initialFundsWei,
                startTime,
                endTime,
                generatedMerkleRoot,
                ipfsCid
            );

            await tx.wait();
        } catch (txError) {
            // Try to get detailed error message
            console.error('Transaction error:', txError);

            // Try to estimate gas to get the revert reason
            try {
                await selectedCommunityToken.registerVoucherIssuance.estimateGas(
                    generatedIssuanceId,
                    name,
                    claimAmountWei,
                    claimLimit,
                    maxTotalClaimWei,
                    initialFundsWei,
                    startTime,
                    endTime,
                    generatedMerkleRoot,
                    ipfsCid
                );
            } catch (estimateError) {
                console.error('Estimate gas error:', estimateError);
                // Extract revert reason if available
                if (estimateError.reason) {
                    throw new Error(`Transaction would fail: ${estimateError.reason}`);
                } else if (estimateError.message) {
                    throw new Error(`Transaction would fail: ${estimateError.message}`);
                }
            }
            throw txError;
        }

        const cidMessage = ipfsCid ? ` (IPFS CID: ${ipfsCid.substring(0, 16)}...)` : '';
        showSuccess(`Voucher issuance registered successfully!${cidMessage}`);

        // Clear form and generated data
        document.getElementById('issuance-name').value = '';
        document.getElementById('code-count').value = '';
        document.getElementById('claim-amount').value = '';
        document.getElementById('claim-limit').value = '';
        document.getElementById('initial-funds').value = '';
        document.getElementById('start-time').value = '';
        document.getElementById('end-time').value = '';
        document.getElementById('generated-codes-info').style.display = 'none';

        generatedCodes = null;
        generatedMerkleRoot = null;
        generatedIssuanceId = null;

        // Reload campaigns list to show the new campaign
        await loadCampaigns();
        await loadManageCampaigns();

    } catch (error) {
        showError('Registration failed: ' + error.message);
    }
}

async function loadCampaigns() {
    try {
        if (!selectedCommunityToken) {
            showError('Please select a community token first');
            return;
        }

        showMessage('Loading campaigns...');

        const issuanceIds = await selectedCommunityToken.getVoucherIssuanceIds();
        const select = document.getElementById('claim-issuance-select');
        select.innerHTML = '<option value="">-- Select a campaign --</option>';

        if (issuanceIds.length === 0) {
            showMessage('No campaigns found');
            return;
        }

        const decimals = await selectedCommunityToken.decimals();
        const now = Math.floor(Date.now() / 1000);
        let activeCount = 0;

        for (const issuanceId of issuanceIds) {
            try {
                const issuance = await selectedCommunityToken.getVoucherIssuanceInfo(issuanceId);

                // Skip terminated campaigns
                if (!issuance.isActive) {
                    continue;
                }

                activeCount++;
                const startTime = Number(issuance.startTime);
                const endTime = Number(issuance.endTime);

                let statusText = '';
                if (startTime > now) {
                    statusText = ' [Pending]';
                } else if (endTime > 0 && endTime < now) {
                    statusText = ' [Ended]';
                } else {
                    statusText = ' [Active]';
                }

                const option = document.createElement('option');
                option.value = issuanceId;
                option.textContent = `${issuance.name}${statusText}`;
                // Convert all values explicitly to avoid BigInt serialization issues
                const issuanceData = {
                    issuanceId: String(issuance.issuanceId),
                    owner: String(issuance.owner),
                    name: String(issuance.name),
                    amountPerClaim: String(issuance.amountPerClaim),
                    countLimitPerUser: String(issuance.countLimitPerUser),
                    totalAmountLimit: String(issuance.totalAmountLimit),
                    startTime: startTime,
                    endTime: endTime,
                    merkleRoot: String(issuance.merkleRoot),
                    isActive: Boolean(issuance.isActive),
                    remainingAmount: String(issuance.remainingAmount),
                    claimedAmount: String(issuance.claimedAmount),
                    claimedDisplayAmount: String(issuance.claimedDisplayAmount),
                    totalClaimCount: String(issuance.totalClaimCount),
                    decimals: Number(decimals),
                    ipfsCid: String(issuance.ipfsCid || '')
                };
                option.dataset.issuance = JSON.stringify(issuanceData);
                select.appendChild(option);
            } catch (e) {
                console.error(`Failed to process issuance ${issuanceId}:`, e);
                // Continue with other issuances
            }
        }

        showSuccess(`Loaded ${activeCount} active campaign(s)`);

    } catch (error) {
        showError('Failed to load campaigns: ' + error.message);
    }
}

async function onCampaignSelected() {
    const select = document.getElementById('claim-issuance-select');
    const issuanceId = select.value;
    const detailsDiv = document.getElementById('issuance-details');

    if (!issuanceId) {
        detailsDiv.style.display = 'none';
        return;
    }

    const option = select.options[select.selectedIndex];
    const issuanceData = JSON.parse(option.dataset.issuance);

    console.log('=== onCampaignSelected Debug ===');
    console.log('Raw issuanceData:', issuanceData);
    console.log('issuanceData.startTime:', issuanceData.startTime, 'type:', typeof issuanceData.startTime);
    console.log('issuanceData.endTime:', issuanceData.endTime, 'type:', typeof issuanceData.endTime);

    const now = Math.floor(Date.now() / 1000);
    const startTime = Number(issuanceData.startTime);
    const endTime = Number(issuanceData.endTime);

    console.log('After Number() conversion:');
    console.log('startTime:', startTime, 'type:', typeof startTime);
    console.log('endTime:', endTime, 'type:', typeof endTime);
    console.log('Start Date:', new Date(startTime * 1000));
    console.log('End Date:', new Date(endTime * 1000));

    let status;
    if (!issuanceData.isActive) {
        status = 'Terminated';
    } else if (startTime > now) {
        status = 'Pending (Not Started)';
    } else if (endTime > 0 && endTime < now) {
        status = 'Ended';
    } else {
        status = 'Active';
    }

    const formatDate = (timestamp) => {
        if (timestamp === 0) return 'Not set';
        return new Date(timestamp * 1000).toLocaleString();
    };

    document.getElementById('detail-name').textContent = issuanceData.name;
    document.getElementById('detail-amount').textContent = ethers.formatUnits(issuanceData.amountPerClaim, issuanceData.decimals);
    document.getElementById('detail-status').textContent = status;
    document.getElementById('detail-period').textContent = `${formatDate(startTime)} - ${formatDate(endTime)}`;

    detailsDiv.style.display = 'block';

    // Auto-load proof from IPFS
    if (issuanceData.ipfsCid) {
        document.getElementById('proof-info').textContent = 'Loading proof data from IPFS...';
        try {
            const leaves = await getLeaves(issuanceData.ipfsCid);
            if (leaves) {
                currentProof = leaves;
                document.getElementById('proof-info').textContent = `Loaded ${currentProof.length} codes from IPFS`;
            } else {
                currentProof = null;
                document.getElementById('proof-info').textContent = 'No proof data available';
            }
        } catch (error) {
            console.error('Failed to load proof from IPFS:', error);
            currentProof = null;
            document.getElementById('proof-info').textContent = `Failed to load proof: ${error.message}`;
        }
    } else {
        currentProof = null;
        document.getElementById('proof-info').textContent = 'No IPFS CID available for this campaign';
    }
}

async function claimVoucher() {
    try {
        showMessage('Checking if claim is possible...');
        const { issuanceId, code, proof } = await prepareClaimData();

        showMessage('Claiming voucher...');
        const tx = await selectedCommunityToken.claimVoucher(issuanceId, code, proof);
        await tx.wait();

        await onCommunityTokenSelected();
        showSuccess('Voucher claimed successfully!');
        document.getElementById('claim-code').value = '';

    } catch (error) {
        showError('Claim failed: ' + error.message);
    }
}

// EIP-712 type definition for ClaimWithAuthorization
const CLAIM_AUTHORIZATION_TYPES = {
    ClaimWithAuthorization: [
        { name: "claimer", type: "address" },
        { name: "issuanceId", type: "string" },
        { name: "code", type: "string" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
    ]
};

// Prepare claim data (validation, proof generation)
async function prepareClaimData(skipCanClaimCheck = false) {
    if (!selectedCommunityToken) {
        throw new Error('Please select a community token first');
    }

    const issuanceId = document.getElementById('claim-issuance-select').value;
    const code = document.getElementById('claim-code').value;

    if (!issuanceId || !code) {
        throw new Error('Please select a campaign and enter code');
    }

    if (!currentProof) {
        throw new Error('Please wait for proof data to load from IPFS');
    }

    const proof = generateProofForCode(code);
    if (!proof) {
        throw new Error('Code not found in proof data');
    }

    const claimer = await signer.getAddress();

    // Pre-check if claim is possible
    if (!skipCanClaimCheck) {
        const [canClaim, errorCode] = await selectedCommunityToken.canClaimVoucher(
            issuanceId, code, proof, claimer
        );

        if (!canClaim) {
            const errorMessages = {
                1: 'Issuance not found',
                2: 'Issuance is not active',
                3: 'Campaign has not started yet',
                4: 'Campaign has already ended',
                5: 'You have reached your claim limit for this campaign',
                6: 'Insufficient funds in the campaign',
                7: 'Maximum total claim amount would be exceeded',
                8: 'Invalid Merkle proof (code verification failed)',
                9: 'This code has already been used'
            };
            throw new Error(errorMessages[errorCode] || `Unknown error (code: ${errorCode})`);
        }
    }

    return { issuanceId, code, proof, claimer };
}

// Prepare EIP-712 signature data
async function prepareEIP712SignatureData(claimer, issuanceId, code) {
    const tokenAddress = await selectedCommunityToken.getAddress();
    const tokenName = await selectedCommunityToken.name();
    const chainId = (await provider.getNetwork()).chainId;

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60; // 1 minute ago (clock skew)
    const validBefore = now + 3600; // 1 hour from now
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    const domain = {
        name: tokenName,
        version: "1",
        chainId: chainId,
        verifyingContract: tokenAddress
    };

    const value = {
        claimer, issuanceId, code, validAfter, validBefore, nonce
    };

    return { domain, types: CLAIM_AUTHORIZATION_TYPES, value, tokenAddress, validAfter, validBefore, nonce };
}

// Sign with EIP-712
async function signEIP712(domain, types, value) {
    const signature = await signer.signTypedData(domain, types, value);
    return ethers.Signature.from(signature);
}

async function claimVoucherWithAuthorization() {
    try {
        showMessage('Checking if claim is possible...');
        const { issuanceId, code, proof, claimer } = await prepareClaimData();

        showMessage('Preparing signature...');
        const { domain, types, value, validAfter, validBefore, nonce } =
            await prepareEIP712SignatureData(claimer, issuanceId, code);

        console.log('=== EIP-712 Signature Debug ===');
        console.log('Domain:', domain);
        console.log('Types:', types);
        console.log('Value:', value);

        showMessage('Please sign the message in your wallet...');
        const sig = await signEIP712(domain, types, value);

        console.log('v:', sig.v, 'r:', sig.r, 's:', sig.s);

        showMessage('Claiming voucher with authorization...');
        const tx = await selectedCommunityToken.claimVoucherWithAuthorization(
            claimer, issuanceId, code, proof,
            validAfter, validBefore, nonce,
            sig.v, sig.r, sig.s
        );
        await tx.wait();

        await onCommunityTokenSelected();
        showSuccess('Voucher claimed with authorization successfully!');
        document.getElementById('claim-code').value = '';

    } catch (error) {
        console.error('Claim with authorization failed:', error);
        showError('Claim with authorization failed: ' + error.message);
    }
}

// Helper to serialize objects with BigInt
function jsonStringifyWithBigInt(obj) {
    return JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    , 2);
}

// Generate signature data for external use (e.g., relayer)
async function generateClaimSignature() {
    try {
        showMessage('Preparing signature data...');
        const { issuanceId, code, proof, claimer } = await prepareClaimData(true); // skip canClaim check

        const { domain, types, value, tokenAddress, validAfter, validBefore, nonce } =
            await prepareEIP712SignatureData(claimer, issuanceId, code);

        showMessage('Please sign the message in your wallet...');
        const sig = await signEIP712(domain, types, value);

        // Get debug info
        let domainSeparator, typeHash;
        try {
            domainSeparator = await selectedCommunityToken.DOMAIN_SEPARATOR();
            typeHash = await selectedCommunityToken.CLAIM_WITH_AUTHORIZATION_TYPEHASH();
        } catch (e) {
            domainSeparator = 'N/A';
            typeHash = DEFAULT_CLAIM_WITH_AUTHORIZATION_TYPEHASH;
        }

        const signatureData = {
            tokenAddress,
            signature: {
                message: { claimer, issuanceId, code, proof, validAfter, validBefore, nonce },
                r: sig.r,
                s: sig.s,
                v: "0x" + sig.v.toString(16)
            },
            debug: { domainSeparator, typeHash, domain, types, value }
        };

        const jsonOutput = jsonStringifyWithBigInt(signatureData);
        console.log('Generated Signature Data:', jsonOutput);

        showSuccess(`Signature generated! Check console for details.\n\n<pre style="text-align:left;font-size:10px;max-height:200px;overflow:auto;">${jsonOutput}</pre>`);

    } catch (error) {
        console.error('Failed to generate signature:', error);
        showError('Failed to generate signature: ' + error.message);
    }
}

function generateProofForCode(code) {
    if (!currentProof) return null;

    try {
        // currentProof contains hashed codes (leaves) loaded from IPFS
        const hashedCode = ethers.keccak256(ethers.toUtf8Bytes(code));

        if (!currentProof.includes(hashedCode)) return null;

        // Generate Merkle proof from leaves
        const proof = generateMerkleProofFromLeaves(currentProof, hashedCode);
        return proof;
    } catch (error) {
        console.error('Failed to generate proof:', error);
        return null;
    }
}

function generateMerkleProof(codes, code) {
    // Hash all codes to create leaves
    const leaves = codes.map(c => ethers.keccak256(ethers.toUtf8Bytes(c)));
    const hashedCode = ethers.keccak256(ethers.toUtf8Bytes(code));

    return generateMerkleProofFromLeaves(leaves, hashedCode);
}

function generateMerkleProofFromLeaves(leaves, hashedCode) {
    // Sort leaves
    const sortedLeaves = [...leaves].sort((a, b) => {
        return ethers.toBigInt(a) < ethers.toBigInt(b) ? -1 : 1;
    });

    // Find code index
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

        index = Math.floor(index / 2);
        currentLevel = nextLevel;
    }

    return proof;
}

async function loadManageCampaigns() {
    try {
        if (!selectedCommunityToken) {
            showError('Please select a community token first');
            return;
        }

        showMessage('Loading campaigns...');

        const issuanceIds = await selectedCommunityToken.getVoucherIssuanceIds();
        const select = document.getElementById('manage-issuance-select');
        select.innerHTML = '<option value="">-- Select a campaign --</option>';

        if (issuanceIds.length === 0) {
            showMessage('No campaigns found');
            return;
        }

        const decimals = await selectedCommunityToken.decimals();
        const now = Math.floor(Date.now() / 1000);
        let activeCount = 0;

        for (const issuanceId of issuanceIds) {
            try {
                const issuance = await selectedCommunityToken.getVoucherIssuanceInfo(issuanceId);

                // Skip terminated campaigns
                if (!issuance.isActive) {
                    continue;
                }

                activeCount++;
                const startTime = Number(issuance.startTime);
                const endTime = Number(issuance.endTime);

                let statusText = '';
                if (startTime > now) {
                    statusText = ' [Pending]';
                } else if (endTime > 0 && endTime < now) {
                    statusText = ' [Ended]';
                } else {
                    statusText = ' [Active]';
                }

                const option = document.createElement('option');
                option.value = issuanceId;
                option.textContent = `${issuance.name}${statusText}`;
                // Convert all values explicitly to avoid BigInt serialization issues
                const issuanceData = {
                    issuanceId: String(issuance.issuanceId),
                    owner: String(issuance.owner),
                    name: String(issuance.name),
                    amountPerClaim: String(issuance.amountPerClaim),
                    countLimitPerUser: String(issuance.countLimitPerUser),
                    totalAmountLimit: String(issuance.totalAmountLimit),
                    startTime: startTime,
                    endTime: endTime,
                    merkleRoot: String(issuance.merkleRoot),
                    isActive: Boolean(issuance.isActive),
                    remainingAmount: String(issuance.remainingAmount),
                    claimedAmount: String(issuance.claimedAmount),
                    claimedDisplayAmount: String(issuance.claimedDisplayAmount),
                    totalClaimCount: String(issuance.totalClaimCount),
                    decimals: Number(decimals),
                    ipfsCid: String(issuance.ipfsCid || '')
                };
                option.dataset.issuance = JSON.stringify(issuanceData);
                select.appendChild(option);
            } catch (e) {
                console.error(`Failed to process issuance ${issuanceId}:`, e);
                // Continue with other issuances
            }
        }

        showSuccess(`Loaded ${activeCount} active campaign(s)`);

    } catch (error) {
        showError('Failed to load campaigns: ' + error.message);
    }
}

async function onManageCampaignSelected() {
    const select = document.getElementById('manage-issuance-select');
    const issuanceId = select.value;
    const detailsDiv = document.getElementById('manage-issuance-details');

    if (!issuanceId) {
        detailsDiv.style.display = 'none';
        return;
    }

    const option = select.options[select.selectedIndex];
    const issuanceData = JSON.parse(option.dataset.issuance);

    const now = Math.floor(Date.now() / 1000);
    const startTime = Number(issuanceData.startTime);
    const endTime = Number(issuanceData.endTime);

    let status;
    if (!issuanceData.isActive) {
        status = 'Terminated';
    } else if (startTime > now) {
        status = 'Pending (Not Started)';
    } else if (endTime > 0 && endTime < now) {
        status = 'Ended';
    } else {
        status = 'Active';
    }

    document.getElementById('manage-detail-name').textContent = issuanceData.name;
    document.getElementById('manage-detail-status').textContent = status;
    document.getElementById('manage-detail-amount').textContent = ethers.formatUnits(issuanceData.claimAmountPerCode, issuanceData.decimals);

    // Display funds info from cached data
    const remainingAmount = BigInt(issuanceData.remainingAmount);
    const claimedAmount = BigInt(issuanceData.claimedAmount);
    const initialFunds = remainingAmount + claimedAmount;

    document.getElementById('manage-detail-initial-funds').textContent = ethers.formatUnits(initialFunds, issuanceData.decimals);
    document.getElementById('manage-detail-remaining-funds').textContent = ethers.formatUnits(remainingAmount, issuanceData.decimals);
    document.getElementById('manage-detail-claimed-amount').textContent = ethers.formatUnits(claimedAmount, issuanceData.decimals);

    detailsDiv.style.display = 'block';
}

async function addFunds() {
    try {
        if (!selectedCommunityToken) {
            showError('Please select a community token first');
            return;
        }

        const issuanceId = document.getElementById('manage-issuance-select').value;
        const amount = document.getElementById('add-funds-amount').value;

        if (!issuanceId) {
            showError('Please select a campaign');
            return;
        }

        if (!amount || parseFloat(amount) <= 0) {
            showError('Please enter a valid amount');
            return;
        }

        // Convert to Wei (displayBalance unit)
        const decimals = await selectedCommunityToken.decimals();
        const amountWei = ethers.parseUnits(amount, decimals);

        showMessage('Adding funds...');

        const tx = await selectedCommunityToken.addVoucherFunds(issuanceId, amountWei);
        await tx.wait();

        showSuccess('Funds added successfully!');
        document.getElementById('add-funds-amount').value = '';

        // Refresh campaign info
        await onManageCampaignSelected();

    } catch (error) {
        showError('Failed to add funds: ' + error.message);
    }
}

async function withdrawFunds() {
    try {
        if (!selectedCommunityToken) {
            showError('Please select a community token first');
            return;
        }

        const issuanceId = document.getElementById('manage-issuance-select').value;
        const amount = document.getElementById('withdraw-funds-amount').value;

        if (!issuanceId) {
            showError('Please select a campaign');
            return;
        }

        if (!amount || parseFloat(amount) <= 0) {
            showError('Please enter a valid amount');
            return;
        }

        // Convert to Wei (displayBalance unit)
        const decimals = await selectedCommunityToken.decimals();
        const amountWei = ethers.parseUnits(amount, decimals);

        showMessage('Withdrawing funds...');

        const tx = await selectedCommunityToken.withdrawVoucherFunds(issuanceId, amountWei);
        await tx.wait();

        showSuccess('Funds withdrawn successfully!');
        document.getElementById('withdraw-funds-amount').value = '';

        // Refresh campaign info
        await onManageCampaignSelected();

    } catch (error) {
        showError('Failed to withdraw funds: ' + error.message);
    }
}

async function terminateIssuance() {
    try {
        if (!selectedCommunityToken) {
            showError('Please select a community token first');
            return;
        }

        const issuanceId = document.getElementById('manage-issuance-select').value;

        if (!issuanceId) {
            showError('Please select a campaign');
            return;
        }

        if (!confirm('Are you sure you want to terminate this issuance? This action cannot be undone.')) {
            return;
        }

        showMessage('Terminating issuance...');

        const tx = await selectedCommunityToken.terminateVoucherIssuance(issuanceId);
        await tx.wait();

        showSuccess('Issuance terminated successfully!');

        // Refresh campaign list
        await loadManageCampaigns();

    } catch (error) {
        showError('Failed to terminate issuance: ' + error.message);
    }
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    if (tab === 'register') {
        document.querySelector('.tab:nth-child(1)').classList.add('active');
        document.getElementById('register-content').classList.add('active');
    } else if (tab === 'claim') {
        document.querySelector('.tab:nth-child(2)').classList.add('active');
        document.getElementById('claim-content').classList.add('active');
        loadCampaigns(); // Auto-load campaigns when switching to claim tab
    } else if (tab === 'manage') {
        document.querySelector('.tab:nth-child(3)').classList.add('active');
        document.getElementById('manage-funds-content').classList.add('active');
        loadManageCampaigns(); // Auto-load campaigns when switching to manage tab
    }
}

function showMessage(msg) {
    document.getElementById('message').innerHTML = `<div class="info">${msg}</div>`;
}

function showError(msg) {
    document.getElementById('message').innerHTML = `<div class="error">${msg}</div>`;
}

function showSuccess(msg) {
    document.getElementById('message').innerHTML = `<div class="success">${msg}</div>`;
}

async function switchNetwork(network) {
    currentNetwork = network;
    PCE_TOKEN_ADDRESS = NETWORKS[currentNetwork].pceToken;

    // Update UI
    document.querySelectorAll('.network-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-network="${network}"]`).classList.add('active');

    // Reinitialize contract if wallet is connected
    if (signer) {
        pceToken = new ethers.Contract(PCE_TOKEN_ADDRESS, PCE_TOKEN_ABI, signer);
        await updateBalance();
        // Reload community tokens for new network
        await loadCommunityTokens();
        // Reset selection
        document.getElementById('community-token-select').value = '';
        document.getElementById('token-info').style.display = 'none';
        document.getElementById('main-section').style.display = 'none';
        selectedCommunityToken = null;
    }

    showMessage(`Switched to ${NETWORKS[currentNetwork].name}`);
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Clean up old cache on page load
    cleanupOldCache();

    // Connect wallet button
    document.getElementById('connect-wallet').addEventListener('click', connectWallet);

    // Community token selection
    document.getElementById('community-token-select').addEventListener('change', onCommunityTokenSelected);

    // Tab switching
    document.querySelectorAll('.tab').forEach((tab, index) => {
        tab.addEventListener('click', () => {
            if (index === 0) switchTab('register');
            else if (index === 1) switchTab('claim');
            else if (index === 2) switchTab('manage');
        });
    });

    // Generate codes button
    document.getElementById('generate-codes-button').addEventListener('click', onGenerateCodesAndMerkleRoot);
    document.getElementById('download-codes-button').addEventListener('click', downloadCodes);

    // Auto-calculate initial funds
    document.getElementById('code-count').addEventListener('input', calculateInitialFunds);
    document.getElementById('claim-amount').addEventListener('input', calculateInitialFunds);

    // Register button
    document.getElementById('register-button').addEventListener('click', registerVoucherIssuance);

    // Campaign selection
    document.getElementById('claim-issuance-select').addEventListener('change', onCampaignSelected);
    document.getElementById('refresh-campaigns-button').addEventListener('click', loadCampaigns);

    // Claim buttons
    document.getElementById('claim-button').addEventListener('click', claimVoucher);
    document.getElementById('claim-with-auth-button').addEventListener('click', claimVoucherWithAuthorization);
    document.getElementById('generate-signature-button').addEventListener('click', generateClaimSignature);

    // Manage funds tab
    document.getElementById('manage-issuance-select').addEventListener('change', onManageCampaignSelected);
    document.getElementById('refresh-manage-campaigns-button').addEventListener('click', loadManageCampaigns);
    document.getElementById('add-funds-button').addEventListener('click', addFunds);
    document.getElementById('withdraw-funds-button').addEventListener('click', withdrawFunds);
    document.getElementById('terminate-issuance-button').addEventListener('click', terminateIssuance);

    // Network switching
    document.querySelectorAll('.network-btn').forEach(btn => {
        btn.addEventListener('click', () => switchNetwork(btn.dataset.network));
    });

    // Set initial network
    switchNetwork(currentNetwork);
});
