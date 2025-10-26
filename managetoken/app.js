import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.15.0/ethers.min.js";

// Configuration
const NETWORKS = {
    'mainnet-prd': {
        name: 'Mainnet Production',
        pceToken: '0xA4807a8C34353A5EA51aF073175950Cb6248dA7E',
        pceSymbol: 'PCE'
    },
    'mainnet-dev': {
        name: 'Mainnet Dev',
        pceToken: '0x62Ef93EAa5bB3E47E0e855C323ef156c8E3D8913',
        pceSymbol: 'DPCE'
    }
};

let currentNetwork = 'mainnet-prd';
let PCE_TOKEN_ADDRESS = NETWORKS[currentNetwork].pceToken;

// ABIs
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function owner() view returns (address)"
];

const PCE_TOKEN_ABI = [
    ...ERC20_ABI,
    "function createToken(string name, string symbol, uint256 amountToExchange, uint256 dilutionFactor, uint256 decreaseIntervalDays, uint16 afterDecreaseBp, uint16 maxIncreaseOfTotalSupplyBp, uint16 maxIncreaseBp, uint16 maxUsageBp, uint16 changeBp, uint8 incomeExchangeAllowMethod, uint8 outgoExchangeAllowMethod, address[] incomeTargetTokens, address[] outgoTargetTokens) returns (address)",
    "function getTokens() view returns (address[])",
    "function swapToLocalToken(address toToken, uint256 amountToSwap)",
    "function getSwapRate(address toToken) view returns (uint256)",
    "event TokenCreated(address indexed tokenAddress, address indexed creator, uint256 pcetokenAmount, uint256 newTokenAmount)"
];

const COMMUNITY_TOKEN_ABI = [
    ...ERC20_ABI,
    "function getCurrentFactor() view returns (uint256)",
    "function setDailySwapLimit(uint256 _limit)",
    "function setIndividualDailySwapLimit(uint256 _limit)",
    "function getTodaySwapableToPCEBalance() view returns (uint256)",
    "function getTodaySwapableToPCEBalanceForIndividual(address user) view returns (uint256)"
];

let provider, signer, pceToken;
let selectedSwapToken = null;
let selectedSettingsToken = null;

// LocalStorage key prefix with version
const CACHE_VERSION = 'v1';
const TOKENS_CACHE_PREFIX = `managetoken_tokens_cache_${CACHE_VERSION}_`;

// Clean up old cache versions
function cleanupOldCache() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('managetoken_tokens_cache_') && !key.startsWith(TOKENS_CACHE_PREFIX)) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    if (keysToRemove.length > 0) {
        console.log(`Cleaned up ${keysToRemove.length} old cache entries`);
    }
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
        document.getElementById('main-section').style.display = 'block';

        // Load balance
        await updateBalance();

        // Listen for account changes
        window.ethereum.on('accountsChanged', connectWallet);

    } catch (error) {
        showError('Failed to connect wallet: ' + error.message);
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

async function registerToken() {
    try {
        // Get elements first to check if they exist
        const nameEl = document.getElementById('register-token-name');
        const symbolEl = document.getElementById('register-token-symbol');
        const amountEl = document.getElementById('register-amount-to-exchange');
        const dilutionEl = document.getElementById('register-dilution-factor');
        const intervalEl = document.getElementById('register-decrease-interval');
        const decreaseBpEl = document.getElementById('register-after-decrease-bp');
        const maxIncreaseTotalEl = document.getElementById('register-max-increase-total-bp');
        const maxIncreaseEl = document.getElementById('register-max-increase-bp');
        const maxUsageEl = document.getElementById('register-max-usage-bp');
        const changeBpEl = document.getElementById('register-change-bp');
        const incomeMethodEl = document.getElementById('register-income-method');
        const outgoMethodEl = document.getElementById('register-outgo-method');

        // Check for missing elements
        const missingElements = [];
        if (!nameEl) missingElements.push('register-token-name');
        if (!symbolEl) missingElements.push('register-token-symbol');
        if (!amountEl) missingElements.push('register-amount-to-exchange');
        if (!dilutionEl) missingElements.push('register-dilution-factor');
        if (!intervalEl) missingElements.push('register-decrease-interval');
        if (!decreaseBpEl) missingElements.push('register-after-decrease-bp');
        if (!maxIncreaseTotalEl) missingElements.push('register-max-increase-total-bp');
        if (!maxIncreaseEl) missingElements.push('register-max-increase-bp');
        if (!maxUsageEl) missingElements.push('register-max-usage-bp');
        if (!changeBpEl) missingElements.push('register-change-bp');
        if (!incomeMethodEl) missingElements.push('register-income-method');
        if (!outgoMethodEl) missingElements.push('register-outgo-method');

        if (missingElements.length > 0) {
            showError('Missing form elements: ' + missingElements.join(', ') + '. Please refresh the page.');
            return;
        }

        const name = nameEl.value;
        const symbol = symbolEl.value;
        const amountToExchange = amountEl.value;
        const dilutionFactor = dilutionEl.value;
        const decreaseInterval = intervalEl.value;
        const afterDecreaseBp = decreaseBpEl.value;
        const maxIncreaseTotalBp = maxIncreaseTotalEl.value;
        const maxIncreaseBp = maxIncreaseEl.value;
        const maxUsageBp = maxUsageEl.value;
        const changeBp = changeBpEl.value;
        const incomeMethod = incomeMethodEl.value;
        const outgoMethod = outgoMethodEl.value;

        if (!name || !symbol || !amountToExchange || !dilutionFactor) {
            showError('Please fill all required fields');
            return;
        }

        if (parseFloat(amountToExchange) <= 0) {
            showError('Amount to exchange must be greater than 0');
            return;
        }

        if (parseFloat(dilutionFactor) < 0.1 || parseFloat(dilutionFactor) > 1000) {
            showError('Dilution factor must be between 0.1 and 1000');
            return;
        }

        showMessage('Creating Community Token...');

        const decimals = await pceToken.decimals();
        const amountToExchangeWei = ethers.parseUnits(amountToExchange, decimals);
        const dilutionFactorWei = ethers.parseUnits(dilutionFactor, decimals);

        // Empty arrays for income/outgo target tokens (can be set later)
        const incomeTargetTokens = [];
        const outgoTargetTokens = [];

        const tx = await pceToken.createToken(
            name,
            symbol,
            amountToExchangeWei,
            dilutionFactorWei,
            decreaseInterval,
            afterDecreaseBp,
            maxIncreaseTotalBp,
            maxIncreaseBp,
            maxUsageBp,
            changeBp,
            incomeMethod,
            outgoMethod,
            incomeTargetTokens,
            outgoTargetTokens
        );
        const receipt = await tx.wait();

        // Find the token address from the event logs
        let tokenAddress = null;
        for (const log of receipt.logs) {
            try {
                const parsed = pceToken.interface.parseLog(log);
                if (parsed && parsed.name === 'TokenCreated') {
                    tokenAddress = parsed.args[0]; // First argument is the token address
                    break;
                }
            } catch (e) {
                // Skip logs that don't match our interface
            }
        }

        if (!tokenAddress) {
            // Fallback: get the latest token from the list
            const tokens = await pceToken.getTokens();
            tokenAddress = tokens[tokens.length - 1];
        }

        // Display success message with token address
        document.getElementById('registered-token-address').textContent = tokenAddress;
        document.getElementById('register-result').style.display = 'block';

        // Store token address for MetaMask import
        document.getElementById('add-token-to-metamask').dataset.tokenAddress = tokenAddress;
        document.getElementById('add-token-to-metamask').dataset.tokenSymbol = symbol;

        showSuccess(`Community Token "${name}" created successfully!`);

        // Clear form
        document.getElementById('register-token-name').value = '';
        document.getElementById('register-token-symbol').value = '';
        document.getElementById('register-amount-to-exchange').value = '';
        document.getElementById('register-dilution-factor').value = '1.0';
        document.getElementById('register-decrease-interval').value = '1';
        document.getElementById('register-after-decrease-bp').value = '9980';
        document.getElementById('register-max-increase-total-bp').value = '10000';
        document.getElementById('register-max-increase-bp').value = '10000';
        document.getElementById('register-max-usage-bp').value = '10000';
        document.getElementById('register-change-bp').value = '10000';
        document.getElementById('register-income-method').value = '3';
        document.getElementById('register-outgo-method').value = '3';

        // Clear token cache and reload token lists
        localStorage.removeItem(TOKENS_CACHE_PREFIX + currentNetwork);
        await loadTokens();

    } catch (error) {
        showError('Registration failed: ' + error.message);
    }
}

async function addTokenToMetaMask() {
    try {
        const tokenAddress = document.getElementById('add-token-to-metamask').dataset.tokenAddress;
        const tokenSymbol = document.getElementById('add-token-to-metamask').dataset.tokenSymbol;

        if (!tokenAddress) {
            showError('No token address found');
            return;
        }

        const wasAdded = await window.ethereum.request({
            method: 'wallet_watchAsset',
            params: {
                type: 'ERC20',
                options: {
                    address: tokenAddress,
                    symbol: tokenSymbol,
                    decimals: 18,
                },
            },
        });

        if (wasAdded) {
            showSuccess(`${tokenSymbol} has been added to MetaMask!`);
        }
    } catch (error) {
        showError(`Failed to add token: ${error.message}`);
    }
}

async function loadTokens() {
    try {
        showMessage('Loading community tokens...');

        const select = document.getElementById('swap-token-select');
        const settingsSelect = document.getElementById('settings-token-select');
        const cacheKey = TOKENS_CACHE_PREFIX + currentNetwork;

        // Load from cache first
        const cachedData = localStorage.getItem(cacheKey);
        let cachedTokens = [];
        if (cachedData) {
            try {
                cachedTokens = JSON.parse(cachedData);
                // Display cached tokens immediately
                updateTokenSelects(select, settingsSelect, cachedTokens);
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
            console.log('Could not fetch tokens from contract');
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
                updateTokenSelects(select, settingsSelect, tokens);

                if (tokens.length > cachedTokens.length) {
                    showSuccess(`Found ${tokens.length - cachedTokens.length} new token(s)! Total: ${tokens.length}`);
                } else {
                    showMessage(`Loaded ${tokens.length} community token(s)`);
                }
            } else {
                showMessage(`${tokens.length} token(s) loaded (up to date)`);
            }
        } else if (tokenAddresses.length === 0 && !cachedData) {
            showMessage('No community tokens found. Register your first token!');
        }

    } catch (error) {
        showError('Failed to load community tokens: ' + error.message);
    }
}

function updateTokenSelects(swapSelect, settingsSelect, tokens) {
    swapSelect.innerHTML = '<option value="">-- Select a token --</option>';
    settingsSelect.innerHTML = '<option value="">-- Select a token --</option>';

    for (const token of tokens) {
        const option1 = document.createElement('option');
        option1.value = token.address;
        option1.textContent = `${token.name} (${token.symbol})`;
        swapSelect.appendChild(option1);

        const option2 = document.createElement('option');
        option2.value = token.address;
        option2.textContent = `${token.name} (${token.symbol})`;
        settingsSelect.appendChild(option2);
    }
}

async function onSwapTokenSelected() {
    try {
        const select = document.getElementById('swap-token-select');
        const tokenAddress = select.value;

        if (!tokenAddress) {
            document.getElementById('swap-token-info').style.display = 'none';
            selectedSwapToken = null;
            return;
        }

        selectedSwapToken = new ethers.Contract(tokenAddress, COMMUNITY_TOKEN_ABI, signer);

        // Get token info
        const name = await selectedSwapToken.name();
        const symbol = await selectedSwapToken.symbol();
        const address = await signer.getAddress();
        const balance = await selectedSwapToken.balanceOf(address);
        const decimals = await selectedSwapToken.decimals();

        // Get swap rate from PCE Token (this includes factor adjustments)
        const swapRate = await pceToken.getSwapRate(tokenAddress);
        // swapRate is: (exchangeRate << 96) / INITIAL_FACTOR * targetFactor / pceFactor
        // We need to divide by 2^96 to get the actual rate
        const swapRateValue = Number(swapRate) / Math.pow(2, 96);

        // Update UI
        document.getElementById('swap-token-name').textContent = name;
        document.getElementById('swap-token-symbol').textContent = symbol;
        document.getElementById('swap-token-balance').textContent = ethers.formatUnits(balance, decimals);
        document.getElementById('swap-exchange-rate').textContent = swapRateValue.toFixed(6);
        document.getElementById('swap-rate-symbol').textContent = symbol;
        document.getElementById('swap-token-info').style.display = 'block';

        showSuccess(`Selected ${name} (${symbol})`);

    } catch (error) {
        showError('Failed to load token info: ' + error.message);
    }
}

async function calculateSwapPreview() {
    try {
        const amount = document.getElementById('swap-amount').value;
        if (!amount || parseFloat(amount) <= 0 || !selectedSwapToken) {
            document.getElementById('swap-preview').style.display = 'none';
            return;
        }

        const symbol = await selectedSwapToken.symbol();
        const tokenAddress = await selectedSwapToken.getAddress();

        // Get swap rate from PCE Token (this includes factor adjustments)
        const swapRate = await pceToken.getSwapRate(tokenAddress);
        // swapRate is: (exchangeRate << 96) / INITIAL_FACTOR * targetFactor / pceFactor
        // We need to divide by 2^96 to get the actual rate
        const swapRateValue = Number(swapRate) / Math.pow(2, 96);

        // Calculate receive amount
        const receiveAmount = parseFloat(amount) * swapRateValue;

        document.getElementById('swap-receive-amount').textContent = receiveAmount.toFixed(6);
        document.getElementById('swap-receive-symbol').textContent = symbol;
        document.getElementById('swap-preview').style.display = 'block';

    } catch (error) {
        console.error('Failed to calculate preview:', error);
    }
}

async function swapToCommunityToken() {
    try {
        if (!selectedSwapToken) {
            showError('Please select a community token first');
            return;
        }

        const amount = document.getElementById('swap-amount').value;
        if (!amount || parseFloat(amount) <= 0) {
            showError('Please enter a valid amount');
            return;
        }

        const decimals = await pceToken.decimals();
        const amountWei = ethers.parseUnits(amount, decimals);

        showMessage('Swapping PCE to Community Token...');

        const tokenAddress = await selectedSwapToken.getAddress();
        const tx = await pceToken.swapToLocalToken(tokenAddress, amountWei);
        await tx.wait();

        showSuccess(`Successfully swapped ${amount} PCE!`);
        document.getElementById('swap-amount').value = '';
        document.getElementById('swap-preview').style.display = 'none';

        // Refresh balances
        await updateBalance();
        await onSwapTokenSelected();

    } catch (error) {
        showError('Swap failed: ' + error.message);
    }
}

async function onSettingsTokenSelected() {
    try {
        const select = document.getElementById('settings-token-select');
        const tokenAddress = select.value;

        if (!tokenAddress) {
            document.getElementById('settings-token-info').style.display = 'none';
            document.getElementById('settings-forms').style.display = 'none';
            selectedSettingsToken = null;
            return;
        }

        selectedSettingsToken = new ethers.Contract(tokenAddress, COMMUNITY_TOKEN_ABI, signer);

        // Get token info
        const name = await selectedSettingsToken.name();
        const symbol = await selectedSettingsToken.symbol();
        const owner = await selectedSettingsToken.owner();
        const totalSupply = await selectedSettingsToken.totalSupply();
        const decimals = await selectedSettingsToken.decimals();

        const userAddress = await signer.getAddress();

        // Update UI
        document.getElementById('settings-token-name').textContent = name;
        document.getElementById('settings-token-symbol').textContent = symbol;
        document.getElementById('settings-token-address').textContent = tokenAddress;
        document.getElementById('settings-token-owner').textContent = owner;
        document.getElementById('settings-total-supply').textContent = ethers.formatUnits(totalSupply, decimals);
        document.getElementById('settings-token-info').style.display = 'block';

        // Show settings forms only if user is the owner
        if (owner.toLowerCase() === userAddress.toLowerCase()) {
            document.getElementById('settings-forms').style.display = 'block';
            showSuccess(`Selected ${name} (${symbol}). You are the owner!`);
        } else {
            document.getElementById('settings-forms').style.display = 'none';
            showMessage(`Selected ${name} (${symbol}). Only the owner can modify settings.`);
        }

    } catch (error) {
        showError('Failed to load token info: ' + error.message);
    }
}

async function updateExchangeRate() {
    try {
        if (!selectedSettingsToken) {
            showError('Please select a token first');
            return;
        }

        const newRate = document.getElementById('settings-new-exchange-rate').value;
        if (!newRate || parseFloat(newRate) <= 0) {
            showError('Please enter a valid exchange rate');
            return;
        }

        showMessage('Updating exchange rate...');

        // Note: This would require a function in the token contract to update exchange rate
        // The current PCECommunityTokenV9 doesn't have this function exposed
        showError('Exchange rate update is not yet implemented in the token contract');

    } catch (error) {
        showError('Failed to update exchange rate: ' + error.message);
    }
}

async function updateSwapLimits() {
    try {
        if (!selectedSettingsToken) {
            showError('Please select a token first');
            return;
        }

        const dailyLimit = document.getElementById('settings-daily-limit').value;
        const individualLimit = document.getElementById('settings-individual-limit').value;

        if (!dailyLimit && !individualLimit) {
            showError('Please enter at least one limit');
            return;
        }

        showMessage('Updating swap limits...');

        const decimals = await selectedSettingsToken.decimals();

        if (dailyLimit && parseFloat(dailyLimit) > 0) {
            const dailyLimitWei = ethers.parseUnits(dailyLimit, decimals);
            const tx1 = await selectedSettingsToken.setDailySwapLimit(dailyLimitWei);
            await tx1.wait();
        }

        if (individualLimit && parseFloat(individualLimit) > 0) {
            const individualLimitWei = ethers.parseUnits(individualLimit, decimals);
            const tx2 = await selectedSettingsToken.setIndividualDailySwapLimit(individualLimitWei);
            await tx2.wait();
        }

        showSuccess('Swap limits updated successfully!');
        document.getElementById('settings-daily-limit').value = '';
        document.getElementById('settings-individual-limit').value = '';

    } catch (error) {
        showError('Failed to update swap limits: ' + error.message);
    }
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    if (tab === 'register') {
        document.querySelector('.tab:nth-child(1)').classList.add('active');
        document.getElementById('register-content').classList.add('active');
    } else if (tab === 'swap') {
        document.querySelector('.tab:nth-child(2)').classList.add('active');
        document.getElementById('swap-content').classList.add('active');
        loadTokens(); // Auto-load tokens when switching to swap tab
    } else if (tab === 'settings') {
        document.querySelector('.tab:nth-child(3)').classList.add('active');
        document.getElementById('settings-content').classList.add('active');
        loadTokens(); // Auto-load tokens when switching to settings tab
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

        // Clear token selections and UI
        document.getElementById('swap-token-select').value = '';
        document.getElementById('settings-token-select').value = '';
        document.getElementById('swap-token-info').style.display = 'none';
        document.getElementById('settings-token-info').style.display = 'none';
        document.getElementById('settings-forms').style.display = 'none';
        selectedSwapToken = null;
        selectedSettingsToken = null;

        // Reload tokens for the new network
        await loadTokens();
    }

    showMessage(`Switched to ${NETWORKS[currentNetwork].name}`);
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Clean up old cache on page load
    cleanupOldCache();

    // Connect wallet button
    document.getElementById('connect-wallet').addEventListener('click', connectWallet);

    // Tab switching
    document.querySelectorAll('.tab').forEach((tab, index) => {
        tab.addEventListener('click', () => {
            if (index === 0) switchTab('register');
            else if (index === 1) switchTab('swap');
            else if (index === 2) switchTab('settings');
        });
    });

    // Register tab
    document.getElementById('register-button').addEventListener('click', registerToken);
    document.getElementById('add-token-to-metamask').addEventListener('click', addTokenToMetaMask);

    // Swap tab
    document.getElementById('swap-token-select').addEventListener('change', onSwapTokenSelected);
    document.getElementById('refresh-tokens-button').addEventListener('click', loadTokens);
    document.getElementById('swap-amount').addEventListener('input', calculateSwapPreview);
    document.getElementById('swap-button').addEventListener('click', swapToCommunityToken);

    // Settings tab
    document.getElementById('settings-token-select').addEventListener('change', onSettingsTokenSelected);
    document.getElementById('refresh-settings-tokens-button').addEventListener('click', loadTokens);
    document.getElementById('update-exchange-rate-button').addEventListener('click', updateExchangeRate);
    document.getElementById('update-swap-limits-button').addEventListener('click', updateSwapLimits);

    // Network switching
    document.querySelectorAll('.network-btn').forEach(btn => {
        btn.addEventListener('click', () => switchNetwork(btn.dataset.network));
    });

    // Set initial network
    switchNetwork(currentNetwork);
});
