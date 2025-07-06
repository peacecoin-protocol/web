# WPCE Web Interface

A simple web interface for wrapping and unwrapping PCE tokens.

## Setup

1. Update the contract addresses in `app.js`:
   ```javascript
   const NETWORKS = {
       'mainnet-beta': {
           pceToken: '0x...', // Your mainnet-beta PCE token address
           wpceToken: '0x...' // Your mainnet-beta WPCE token address
       },
       'mainnet-dev': {
           pceToken: '0x...', // Your mainnet-dev PCE token address
           wpceToken: '0x...' // Your mainnet-dev WPCE token address
       }
   };
   ```

2. Host the file:
   - **Local testing**: Run `python3 -m http.server 8000` in this directory
   - **GitHub Pages**: Push to a repository and enable GitHub Pages
   - **IPFS**: Upload to IPFS for decentralized hosting

## Features

- **Network Switching**: Toggle between mainnet-beta and mainnet-dev
- **EIP-7702 Ready**: Prepared for one-click wrapping when wallets support it
- **Traditional Fallback**: Currently uses approve + depositFor method
- **Balance Display**: Shows both PCE and WPCE balances
- **Simple UI**: Easy to use interface for non-technical users

## Usage

1. Connect MetaMask wallet
2. Select network (mainnet-beta or mainnet-dev)
3. Enter amount to wrap/unwrap
4. Click the button to execute transaction
5. Approve the PCE spending (first time only)
6. Confirm the wrap transaction

## EIP-7702 Support

The app is ready for EIP-7702 (Pectra upgrade) which will enable:
- One-click wrapping without separate approval
- Lower gas costs
- Better user experience

Currently disabled as wallets don't support it yet. To enable when available:
```javascript
const eip7702Enabled = true; // Change from false to true
```

## Security

- No backend required
- All transactions happen directly on-chain
- Private keys never leave MetaMask
- Contract addresses are hardcoded (no external dependencies)