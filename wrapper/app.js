import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.15.0/ethers.min.js";

// Configuration - Update these addresses after deployment
const NETWORKS = {
    'mainnet-prd': {
        name: 'Mainnet Production',
        pceToken: '0x7c28310CC0b8d898c57b93913098e74a3ba23228', // Update with actual mainnet-prd PCE address
        wpceToken: '0xeB5e0632eD3C635E0fa07420A328b49a7D0E6e6d', // Update with actual mainnet-prd WPCE address
        pceSymbol: 'PCE',
        wpceSymbol: 'WPCE'
    },
    'mainnet-dev': {
        name: 'Mainnet Dev',
        pceToken: '0xF26170DE22f2593cbebE296651D039F3B4637E5C',
        wpceToken: '0x9814638c31513F3aAE8259936489a1B50e00e68E',
        pceSymbol: 'DPCE',
        wpceSymbol: 'DWPCE'
    }
};

let currentNetwork = 'mainnet-prd';
let PCE_TOKEN_ADDRESS = NETWORKS[currentNetwork].pceToken;
let WPCE_TOKEN_ADDRESS = NETWORKS[currentNetwork].wpceToken;

// ABIs
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function name() view returns (string)",
    "function decimals() view returns (uint8)"
];

const WPCE_ABI = [
    ...ERC20_ABI,
    "function depositFor(address account, uint256 amount) returns (bool)",
    "function withdrawTo(address account, uint256 amount) returns (bool)",
    "function approveAndWrap(uint256 amount) returns (bool)",
    "function callerHasCode() view returns (bool)"
];

let provider, signer, pceToken, wpceToken;

async function connectWallet() {
    try {
        if (typeof window.ethereum === 'undefined') {
            showError('Please install MetaMask to use this app');
            return;
        }

        await window.ethereum.request({ method: 'eth_requestAccounts' });
        provider = new ethers.BrowserProvider(window.ethereum);

        // Verify connected to Ethereum mainnet (chainId 1)
        const network = await provider.getNetwork();
        if (network.chainId !== 1n) {
            showError('Please switch MetaMask to Ethereum Mainnet (chainId 1)');
            return;
        }

        signer = await provider.getSigner();

        const address = await signer.getAddress();
        document.getElementById('wallet-address').textContent = address.substring(0, 6) + '...' + address.substring(38);

        // Initialize contracts
        pceToken = new ethers.Contract(PCE_TOKEN_ADDRESS, ERC20_ABI, signer);
        wpceToken = new ethers.Contract(WPCE_TOKEN_ADDRESS, WPCE_ABI, signer);

        // Update UI
        document.getElementById('connect-wallet').style.display = 'none';
        document.getElementById('wallet-info').style.display = 'block';
        document.getElementById('main-section').style.display = 'block';

        // Load balances
        await updateBalances();

        // Listen for account/chain changes
        window.ethereum.on('accountsChanged', connectWallet);
        window.ethereum.on('chainChanged', () => window.location.reload());

    } catch (error) {
        showError('Failed to connect wallet: ' + error.message);
    }
}

async function updateBalances() {
    try {
        const address = await signer.getAddress();
        const pceBalance = await pceToken.balanceOf(address);
        const wpceBalance = await wpceToken.balanceOf(address);
        const pceDecimals = await pceToken.decimals();
        const wpceDecimals = await wpceToken.decimals();

        document.getElementById('pce-balance').textContent = ethers.formatUnits(pceBalance, pceDecimals);
        document.getElementById('wpce-balance').textContent = ethers.formatUnits(wpceBalance, wpceDecimals);
    } catch (error) {
        console.error('Failed to update balances:', error);
    }
}

async function wrapTokens() {
    try {
        const amount = document.getElementById('wrap-amount').value;
        if (!amount || amount <= 0) {
            showError('Please enter a valid amount');
            return;
        }

        const decimals = await pceToken.decimals();
        const amountWei = ethers.parseUnits(amount, decimals);

        // Use traditional method (approve + deposit)
        // EIP-7702 and Smart Account support will be added when wallets are ready
        await wrapTraditional(amountWei);

        await updateBalances();
        showSuccess('Successfully wrapped ' + amount + ' PCE to WPCE!');
        document.getElementById('wrap-amount').value = '';

    } catch (error) {
        showError('Wrap failed: ' + error.message);
    }
}

// Future implementations for when wallet support is ready
// async function wrapWithEIP7702(amountWei) { ... }
// async function wrapWithSmartAccount(amountWei) { ... }

async function wrapTraditional(amountWei) {
    // Check current allowance
    const owner = await signer.getAddress();
    const wpceAddress = await wpceToken.getAddress();
    const allowance = await pceToken.allowance(owner, wpceAddress);

    if (allowance < amountWei) {
        showMessage('Approving PCE tokens...');
        const approveTx = await pceToken.approve(wpceAddress, amountWei);
        await approveTx.wait();
    }

    showMessage('Wrapping PCE tokens...');
    const depositTx = await wpceToken.depositFor(owner, amountWei);
    await depositTx.wait();
}


async function unwrapTokens() {
    try {
        const amount = document.getElementById('unwrap-amount').value;
        if (!amount || amount <= 0) {
            showError('Please enter a valid amount');
            return;
        }

        const decimals = await wpceToken.decimals();
        const amountWei = ethers.parseUnits(amount, decimals);
        const owner = await signer.getAddress();

        showMessage('Processing unwrap transaction...');

        const tx = await wpceToken.withdrawTo(owner, amountWei);
        await tx.wait();

        await updateBalances();
        showSuccess('Successfully unwrapped ' + amount + ' WPCE to PCE!');
        document.getElementById('unwrap-amount').value = '';

    } catch (error) {
        showError('Unwrap failed: ' + error.message);
    }
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    if (tab === 'wrap') {
        document.querySelector('.tab:first-child').classList.add('active');
        document.getElementById('wrap-content').classList.add('active');
    } else {
        document.querySelector('.tab:last-child').classList.add('active');
        document.getElementById('unwrap-content').classList.add('active');
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
    WPCE_TOKEN_ADDRESS = NETWORKS[currentNetwork].wpceToken;

    // Update UI
    document.querySelectorAll('.network-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-network="${network}"]`).classList.add('active');

    // Reinitialize contracts if wallet is connected
    if (signer) {
        pceToken = new ethers.Contract(PCE_TOKEN_ADDRESS, ERC20_ABI, signer);
        wpceToken = new ethers.Contract(WPCE_TOKEN_ADDRESS, WPCE_ABI, signer);
        await updateBalances();
    }

    // Check if addresses are configured
    if (PCE_TOKEN_ADDRESS === '0x0000000000000000000000000000000000000000' ||
        WPCE_TOKEN_ADDRESS === '0x0000000000000000000000000000000000000000') {
        showError(`Please update the contract addresses for ${NETWORKS[currentNetwork].name}`);
    } else {
        showMessage(`Switched to ${NETWORKS[currentNetwork].name}`);
    }
}

async function addTokenToMetaMask(tokenType) {
    try {
        if (typeof window.ethereum === 'undefined') {
            showError('Please install MetaMask to use this feature');
            return;
        }

        const tokenAddress = tokenType === 'pce' ? PCE_TOKEN_ADDRESS : WPCE_TOKEN_ADDRESS;
        const tokenSymbol = tokenType === 'pce' ? NETWORKS[currentNetwork].pceSymbol : NETWORKS[currentNetwork].wpceSymbol;
        const tokenDecimals = 18; // Both tokens use 18 decimals

        const wasAdded = await window.ethereum.request({
            method: 'wallet_watchAsset',
            params: {
                type: 'ERC20',
                options: {
                    address: tokenAddress,
                    symbol: tokenSymbol,
                    decimals: tokenDecimals,
                },
            },
        });

        if (wasAdded) {
            showSuccess(`${tokenSymbol} has been added to MetaMask!`);
        } else {
            showMessage(`${tokenSymbol} was not added to MetaMask`);
        }
    } catch (error) {
        showError(`Failed to add token: ${error.message}`);
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Connect wallet button
    document.getElementById('connect-wallet').addEventListener('click', connectWallet);

    // Tab switching
    document.querySelectorAll('.tab').forEach((tab, index) => {
        tab.addEventListener('click', () => switchTab(index === 0 ? 'wrap' : 'unwrap'));
    });

    // Wrap/Unwrap buttons
    document.getElementById('wrap-button').addEventListener('click', wrapTokens);
    document.getElementById('unwrap-button').addEventListener('click', unwrapTokens);

    // Network switching
    document.querySelectorAll('.network-btn').forEach(btn => {
        btn.addEventListener('click', () => switchNetwork(btn.dataset.network));
    });

    // Token import buttons
    document.getElementById('import-pce').addEventListener('click', () => addTokenToMetaMask('pce'));
    document.getElementById('import-wpce').addEventListener('click', () => addTokenToMetaMask('wpce'));

    // Set initial network
    switchNetwork(currentNetwork);
});
