(
  function () {
    angular
      .module('multiSigWeb')
      .service('Transaction', function (Web3Service, Wallet, $rootScope, $q) {
        var factory = {
          requiredReceipt: {},
          requiredInfo: {},
          updates: 0,
          callbacks: {}
        };

        function getTransactionInfo(info) {
          if (info) {
            // Convert info object to an object containing checksum addresses
            // info = Web3Service.toChecksumAddress(info);
            factory.update(info.id, { info: info });
            if (factory.callbacks[info.id]) {
              factory.callbacks[info.id](info);
            }
          }
        }

        factory.get = function () {
          return JSON.parse(localStorage.getItem("transactions")) || {};
        };

        /**
        * Add transaction object to the transactions collection
        */
        factory.add = function (tx) {
          // Convert incoming object's addresses to checksummed ones
          // tx = Web3Service.toChecksumAddress(tx);
          
          var transactions = factory.get();
          transactions[tx.txHash] = tx;
          if (tx.callback) {
            factory.callbacks[tx.txHash] = tx.callback;
          }
          tx.date = new Date();
          console.log('Transaction: ', tx);
          localStorage.setItem("transactions", JSON.stringify(transactions));
          factory.updates++;
          try {
            $rootScope.$digest();
          }
          catch (e) {}

          Web3Service.tronWeb.trx.getTransactionInfo(tx.txHash).then((info) => {
            factory.update(info.id, {info: info});
          });
        };

        factory.update = function (txHash, newObj) {
          var transactions = factory.get();
          // Convert incoming object's addresses to checksummed ones
          // newObj = Web3Service.toChecksumAddress(newObj);
          // txHash = Web3Service.toChecksumAddress(txHash);
          Object.assign(transactions[txHash], newObj);
          localStorage.setItem("transactions", JSON.stringify(transactions));
          factory.updates++;
          try {
            $rootScope.$digest();
          }
          catch (e) { }
        };

        factory.notifyObservers = function () {
          factory.updates++;
        };

        /**
        * Remove transaction identified by transaction hash from the transactions collection
        */
        factory.remove = function (txHash) {
          var transactions = factory.get();
          delete transactions[txHash];
          localStorage.setItem("transactions", JSON.stringify(transactions));
          factory.updates++;
          try {
            $rootScope.$digest();
          }
          catch (e) { }
        };

        /**
        * Remove all transactions
        */
        factory.removeAll = function () {
          localStorage.removeItem("transactions");
          factory.updates++;
          try {
            $rootScope.$digest();
          }
          catch (e) { }
        };

        /**
        * Send transaction, signed by wallet service provider
        */
        factory.sendTrx = function (tx, cb) {
          Web3Service.tronWeb.transactionBuilder.sendTrx(
            tx.to,
            tx.value.toString(),
            tx.from
          ).then(function (transaction) {
            Web3Service.tronWeb.trx.sign(transaction).then(function (signed) {
              Web3Service.tronWeb.trx.sendRawTransaction(signed).then(
                function (result) {
                  factory.add({
                    txHash: result.transaction.txID,
                    callback: function (receipt) {
                      cb(null ,receipt);
                    }
                  })
                },
                function (e) {
                  console.log('kek: ', e);
                  cb(e);
                },
              );
            }, function (e) {
              cb(e);
            });
          }, function (e) {
            cb(e);
          });
        };

        factory.simulate = function (tx, cb) {
          var options = Object.assign({ onlySimulate: true }, tx);

          Web3Service.sendTransaction(
            Web3Service.web3.eth,
            [
              tx
            ],
            options,
            function (e, txHash) {
              if (e) {
                cb(e);
              }
              else {
                cb(null, txHash);
              }
            }
          );
        };

        /**
        * Sign transaction without sending it to an ethereum node
        */
        factory.signOffline = function (txObject, cb) {
          Wallet.getUserNonce(function (e, nonce) {
            if (e) {
              cb(e);
            }
            else {
              // Create transaction object
              var txInfo = {
                from: Web3Service.coinbase,
                to: txObject.to,
                value: txObject.value,
                gasPrice: ethereumjs.Util.intToHex(Wallet.txParams.gasPrice),
                gas: ethereumjs.Util.intToHex(Wallet.txParams.gasLimit),
                nonce: ethereumjs.Util.intToHex(nonce)
              };

              Web3Service.web3.eth.signTransaction(txInfo, function (e, signed) {
                if (e) {
                  cb(e);
                }
                else {
                  cb(e, signed.raw);
                }
              });
            }
          });
        };

        /**
        * Sign transaction without sending it to an ethereum node. Needs abi,
        * selected method to execute and related params.
        */
        factory.signMethodOffline = function (tx, abi, method, params, cb) {

          // Get data
          var instance = Web3Service.web3.eth.contract(abi).at(tx.to);

          tx.data = instance[method].getData.apply(this, params);

          factory.signOffline(tx, cb);
        };

        /**
        * Send transaction, signed by wallet service provider. Needs abi,
        * selected method to execute and related params.
        */
        factory.sendMethod = function (tx, abi, method, params, cb) {
          // Instance contract
          var instance = Web3Service.web3.eth.contract(abi).at(tx.to);
          var transactionParams = params.slice();
          transactionParams.push(tx);

          try {
            Web3Service.sendTransaction(
              instance[method],
              transactionParams,
              { onlySimulate: false },
              function (e, txHash) {
                if (e) {
                  cb(e);
                }
                else {
                  // Add transaction
                  factory.add(
                    {
                      txHash: txHash,
                      callback: function (receipt) {
                        cb(null, receipt);
                      }
                    }
                  );
                  cb(null, txHash);
                }
              });
          }
          catch (e) {
            cb(e);
          }
        };

        factory.simulateMethod = function (tx, abi, method, params, cb) {
          // Instance contract
          var instance = Web3Service.web3.eth.contract(abi).at(tx.to);
          var options = Object.assign({ onlySimulate: true }, tx);

          try {
            Web3Service.sendTransaction(
              instance[method],
              params,
              options,
              function (e, txHash) {
                if (e) {
                  cb(e);
                }
                else {
                  cb(null, txHash);
                }
              });
          }
          catch (e) {
            cb(e);
          }
        };

        /**
        * Send signed transaction
        **/
        factory.sendRawTransaction = function (tx, cb) {
          Web3Service.web3.eth.sendRawTransaction(
            tx,
            cb
          );
        };

        /**
        * Internal loop, checking for transaction receipts and transaction info.
        * calls callback after receipt is retrieved.
        */
        factory.checkReceipts = function () {
          // Add transactions without receipt to batch request
          var transactions = factory.get();
          var txHashes = Object.keys(transactions);

          for (var i = 0; i < txHashes.length; i++) {
            var tx = transactions[txHashes[i]];
            // Get transaction info
            if (tx && !tx.info) {
              Web3Service.tronWeb.trx.getTransactionInfo(txHashes[i]).then(getTransactionInfo, (e) => {});
            }
          }
        };

        factory.getTronChain = function () {
          return new Promise(function (resolve, reject) {
            Web3Service.tronWeb.trx.getBlock(0).then(function (block) {
              var data = {};
              if (block && block.blockID == "0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc") {
                data.chain = "nile";
                data.etherscan = "https://nile.tronscan.org";
                data.walletFactoryAddress = txDefault.walletFactoryAddresses["nile"].address;
              }
              else if (block && block.blockID == "0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e") {
                data.chain = "shasta";
                data.etherscan = "https://shasta.tronscan.org";
                data.walletFactoryAddress = txDefault.walletFactoryAddresses["shasta"].address;
              }
              else if (block && block.blockID == "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc") {
                data.chain = "mainnet";
                data.etherscan = "https://tronscan.org";
                data.walletFactoryAddress = txDefault.walletFactoryAddresses["mainnet"].address;
              }
              resolve(data);
            });
          });
          return $q(function (resolve, reject) {
            Web3Service.tronWeb.trx.getBlock(0).then()
            Web3Service.web3.eth.getBlock(0, function (e, block) {
              var data = {};

              if (e) {
                reject();
              }
              else if (block && block.hash == "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3") {
                data.chain = "mainnet";
                data.etherscan = "https://etherscan.io";
                data.walletFactoryAddress = txDefault.walletFactoryAddresses["mainnet"].address;
              }
              else if (block && block.hash == "0x41941023680923e0fe4d74a34bdac8141f2540e3ae90623718e47d66d1ca4a2d") {
                data.chain = "ropsten";
                data.etherscan = "https://ropsten.etherscan.io";
                data.walletFactoryAddress = txDefault.walletFactoryAddresses["ropsten"].address;
              }
              else if (block && block.hash == "0xa3c565fc15c7478862d50ccd6561e3c06b24cc509bf388941c25ea985ce32cb9") {
                data.chain = "kovan";
                data.etherscan = "https://kovan.etherscan.io";
                data.walletFactoryAddress = txDefault.walletFactoryAddresses["kovan"].address;
              }
              else if (block && block.hash == "0x6341fd3daf94b748c72ced5a5b26028f2474f5f00d824504e4fa37a75767e177") {
                data.chain = "rinkeby";
                data.etherscan = "https://rinkeby.etherscan.io";
                data.walletFactoryAddress = txDefault.walletFactoryAddresses["rinkeby"].address;
              }
              else {
                data.chain = "privatenet";
                data.etherscan = "https://testnet.etherscan.io";
                data.walletFactoryAddress = txDefault.walletFactoryAddresses["privatenet"].address;
              }

              resolve(data);
            });
          });
        };

        return factory;
      });
  }
)();
