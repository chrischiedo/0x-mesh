import { getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import { DummyERC20TokenContract } from '@0x/contracts-erc20';
import { ExchangeContract } from '@0x/contracts-exchange';
import { blockchainTests, constants, expect, OrderFactory, orderHashUtils } from '@0x/contracts-test-utils';
import { BlockchainLifecycle, Web3Config, web3Factory } from '@0x/dev-utils';
import { assetDataUtils } from '@0x/order-utils';
import { Web3ProviderEngine } from '@0x/subproviders';
import { DoneCallback, SignedOrder } from '@0x/types';
import { BigNumber, hexUtils } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import 'mocha';
// import * as uuidValidate from 'uuid-validate';
// import * as WebSocket from 'websocket';

import { OrderEvent, OrderEventEndState, RejectedOrderCode } from '../src/index';
// import { ContractEventKind, ExchangeCancelEvent, OrderInfo, RejectedKind, WSMessage } from '../src/types';

// import { SERVER_PORT, setupServerAsync, stopServer } from './utils/mock_ws_server';
import { MeshDeployment, startServerAndClientAsync } from './utils/graphql_server';

blockchainTests.resets('GraphQLClient', env => {
    describe('integration tests', () => {
        let deployment: MeshDeployment;
        let exchange: ExchangeContract;
        let exchangeAddress: string;
        let makerAddress: string;
        let orderFactory: OrderFactory;
        let provider: Web3ProviderEngine;

        beforeEach(async () => {
            deployment = await startServerAndClientAsync();
        });

        afterEach(async () => {
            deployment.mesh.stopMesh();
        });

        before(async () => {
            const chainId = await env.getChainIdAsync();
            const accounts = await env.getAccountAddressesAsync();
            [makerAddress] = accounts;

            // Create a new provider so that the ganache instance running on port
            // 8545 will be used instead of the in-process ganache instance.
            const providerConfigs: Web3Config = {
                total_accounts: constants.NUM_TEST_ACCOUNTS,
                shouldUseInProcessGanache: false,
                shouldAllowUnlimitedContractSize: true,
                unlocked_accounts: [makerAddress],
            };
            provider = web3Factory.getRpcProvider(providerConfigs);

            // HACK(jalextowle): We can't currently specify an out of process provider for a blockchainTests
            // suite, so we need to update env.blockchainLifecycle so that the resets suite works as expected.
            env.blockchainLifecycle = new BlockchainLifecycle(new Web3Wrapper(provider));

            exchangeAddress = getContractAddressesForChainOrThrow(chainId).exchange;
            exchange = new ExchangeContract(exchangeAddress, provider);
            const erc20ProxyAddress = getContractAddressesForChainOrThrow(chainId).erc20Proxy;

            // Configure two tokens and an order factory with a maker address so
            // that valid orders can be created easily in the tests.
            const makerToken = new DummyERC20TokenContract('0x34d402f14d58e001d8efbe6585051bf9706aa064', provider);
            const feeToken = new DummyERC20TokenContract('0xcdb594a32b1cc3479d8746279712c39d18a07fc0', provider);
            const mintAmount = new BigNumber('100e18');
            // tslint:disable-next-line: await-promise
            await makerToken.mint(mintAmount).awaitTransactionSuccessAsync({ from: makerAddress });
            // tslint:disable-next-line: await-promise
            await feeToken.mint(mintAmount).awaitTransactionSuccessAsync({ from: makerAddress });
            // tslint:disable-next-line: await-promise
            await makerToken
                .approve(erc20ProxyAddress, new BigNumber('100e18'))
                .awaitTransactionSuccessAsync({ from: makerAddress });
            // tslint:disable-next-line: await-promise
            await feeToken
                .approve(erc20ProxyAddress, new BigNumber('100e18'))
                .awaitTransactionSuccessAsync({ from: makerAddress });
            orderFactory = new OrderFactory(constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)], {
                ...constants.STATIC_ORDER_PARAMS,
                feeRecipientAddress: constants.NULL_ADDRESS,
                makerAddress,
                exchangeAddress,
                chainId: 1337,
                makerAssetData: assetDataUtils.encodeERC20AssetData(makerToken.address),
                takerAssetData: assetDataUtils.encodeERC20AssetData(makerToken.address),
                makerFeeAssetData: assetDataUtils.encodeERC20AssetData(feeToken.address),
                takerFeeAssetData: assetDataUtils.encodeERC20AssetData(feeToken.address),
            });
        });

        describe('#addOrdersAsync', async () => {
            it('accepts valid order', async () => {
                const order = await orderFactory.newSignedOrderAsync({});
                const validationResults = await deployment.client.addOrdersAsync([order]);
                expect(validationResults).to.be.deep.eq({
                    accepted: [
                        {
                            isNew: true,
                            order: {
                                ...order,
                                hash: orderHashUtils.getOrderHashHex(order),
                                fillableTakerAssetAmount: order.takerAssetAmount,
                            },
                        },
                    ],
                    rejected: [],
                });
            });

            it('rejects order with invalid signature', async () => {
                const invalidOrder = {
                    ...(await orderFactory.newSignedOrderAsync({})),
                    signature: hexUtils.hash('0x0'),
                };
                const validationResults = await deployment.client.addOrdersAsync([invalidOrder]);
                expect(validationResults).to.be.deep.eq({
                    accepted: [],
                    rejected: [
                        {
                            hash: orderHashUtils.getOrderHashHex(invalidOrder),
                            order: invalidOrder,
                            code: RejectedOrderCode.OrderHasInvalidSignature,
                            message: 'order signature must be valid',
                        },
                    ],
                });
            });
        });

        describe('#getStats', () => {
            it('Ensure that the stats are correct when no orders have been added', async () => {
                const stats = await deployment.client.getStatsAsync();

                // NOTE(jalextowle): Ensure that the latest block of the returned
                // stats is valid and then clear the field since we don't know
                // the block number of the stats in this test a priori.
                expect(stats.latestBlock).to.not.be.undefined();
                // tslint:disable-next-line:no-non-null-assertion
                // expect(stats.latestBlock!.number).to.be.greaterThan(0);
                stats.latestBlock = {
                    number: new BigNumber(0),
                    hash: '',
                };

                const now = new Date(Date.now());
                const expectedStartOfCurrentUTCDay = `${now.getUTCFullYear()}-${leftPad(
                    now.getUTCMonth() + 1,
                )}-${leftPad(now.getUTCDate())}T00:00:00Z`;
                const expectedStats = {
                    version: 'development',
                    pubSubTopic: '/0x-orders/version/3/chain/1337/schema/e30=',
                    rendezvous: '/0x-mesh/network/1337/version/2',
                    peerID: deployment.peerID,
                    ethereumChainID: 1337,
                    latestBlock: {
                        number: new BigNumber(0),
                        hash: '',
                    },
                    numPeers: 0,
                    numOrders: 0,
                    numOrdersIncludingRemoved: 0,
                    maxExpirationTime: constants.MAX_UINT256,
                    startOfCurrentUTCDay: new Date(expectedStartOfCurrentUTCDay),
                    ethRPCRequestsSentInCurrentUTCDay: 0,
                    ethRPCRateLimitExpiredRequests: 0,
                };
                expect(stats).to.be.deep.eq(expectedStats);
            });
        });

        describe('#getOrderAsync', async () => {
            it('gets an order by its hash', async () => {
                const order = await orderFactory.newSignedOrderAsync({});
                const validationResults = await deployment.client.addOrdersAsync([order]);
                expect(validationResults.accepted.length).to.be.eq(1);

                const orderHash = orderHashUtils.getOrderHashHex(order);
                const foundOrder = await deployment.client.getOrderAsync(orderHash);
                const expectedOrder = {
                    ...order,
                    hash: orderHash,
                    fillableTakerAssetAmount: order.takerAssetAmount,
                };
                expect(foundOrder).to.be.deep.eq(expectedOrder);
            });
            it('returns null when the order does not exist', async () => {
                const nonExistentOrderHash = '0xabcd46910c6a8a4730878e6e8a4abb328844c0b58f0cdfbb5b6ad28ee0bae347';
                const foundOrder = await deployment.client.getOrderAsync(nonExistentOrderHash);
                expect(foundOrder).to.be.null();
            });
        });

        //     describe('#getOrdersAsync', async () => {
        //         it('properly makes multiple paginated requests under-the-hood and returns all signedOrders', async () => {
        //             const ordersLength = 10;
        //             const orders = [];
        //             for (let i = 0; i < ordersLength; i++) {
        //                 orders[i] = await orderFactory.newSignedOrderAsync({});
        //             }
        //             const validationResults = await deployment.client.addOrdersAsync(orders);
        //             expect(validationResults.accepted.length).to.be.eq(ordersLength);

        //             // NOTE(jalextowle): The time returned by Date uses milliseconds, but
        //             // the mesh timestamp only uses second. Multiplying the seconds timestamp
        //             // by 1000 gives us a comparable value. We only try to ensure that this
        //             // timestamp is approximately equal (within 1 second) because the server
        //             // will receive the request slightly after it is sent.
        //             const now = new Date(Date.now()).getTime();
        //             const perPage = ordersLength / 2;
        //             const response = await deployment.client.getOrdersAsync(perPage);
        //             assertRoughlyEquals(now, response.snapshotTimestamp * secondsToMs(1), secondsToMs(2));
        //             // Verify that snapshot ID in the response meets the expected schema.
        //             expect(uuidValidate(response.snapshotID)).to.be.true();

        //             // Verify that all of the orders that were added to the mesh node
        //             // were returned in the `getOrders` rpc response
        //             expectContainsOrders(orders, response.ordersInfos);
        //         });
        //     });

        //     describe('#getOrdersForPageAsync', async () => {
        //         it('properly makes paginated request and returns signedOrders', async () => {
        //             const ordersLength = 10;
        //             const orders = [];
        //             for (let i = 0; i < ordersLength; i++) {
        //                 orders[i] = await orderFactory.newSignedOrderAsync({});
        //             }
        //             const validationResults = await deployment.client.addOrdersAsync(orders);
        //             expect(validationResults.accepted.length).to.be.eq(ordersLength);

        //             // NOTE(jalextowle): The time returned by Date uses milliseconds, but
        //             // the mesh timestamp only uses second. Multiplying the seconds timestamp
        //             // by 1000 gives us a comparable value. We only try to ensure that this
        //             // timestamp is approximately equal (within 1 second) because the server
        //             // will receive the request slightly after it is sent.
        //             const now = new Date(Date.now()).getTime();
        //             let page = 0;
        //             const perPage = 5;
        //             // First request for page index 0
        //             let response = await deployment.client.getOrdersForPageAsync(page, perPage);
        //             assertRoughlyEquals(now, response.snapshotTimestamp * secondsToMs(1), secondsToMs(2));
        //             expect(uuidValidate(response.snapshotID)).to.be.true();

        //             let responseOrders = response.ordersInfos;

        //             // Second request for page index 1
        //             page = 1;
        //             response = await deployment.client.getOrdersForPageAsync(page, perPage, response.snapshotID);
        //             expect(uuidValidate(response.snapshotID)).to.be.true();

        //             // Combine orders found in first and second paginated requests
        //             responseOrders = [...responseOrders, ...response.ordersInfos];

        //             // Verify that all of the orders that were added to the mesh node
        //             // were returned in the two `getOrders` rpc response
        //             expectContainsOrders(orders, responseOrders);
        //         });
        //     });

        //     describe('#_subscribeToHeartbeatAsync', async () => {
        //         it('should receive subscription updates', (done: DoneCallback) => {
        //             (async () => {
        //                 const expectToBeCalledOnce = true;
        //                 const callback = callbackErrorReporter.reportNoErrorCallbackErrors(
        //                     done,
        //                     expectToBeCalledOnce,
        //                 )(async (ack: string) => {
        //                     expect(ack).to.be.equal('tick');
        //                 });
        //                 // NOTE(jalextowle): We use string literal access here to
        //                 // avoid casting `deployment.client` to `any` (this method
        //                 // preserves most types of type-checking) and to allow us to
        //                 // access the private method `_subscribeToHeartbeatAsync`.
        //                 // Source: https://stackoverflow.com/a/35991491
        //                 // tslint:disable-next-line:no-string-literal
        //                 await deployment.client['_subscribeToHeartbeatAsync'](callback);
        //             })().catch(done);
        //         });
        //     });

        describe('#subscribeToOrdersAsync', async () => {
            it('should receive subscription updates about added orders', (done: DoneCallback) => {
                (async () => {
                    // Create orders to add to the mesh node.
                    const ordersLength = 10;
                    const orders = [] as SignedOrder[];
                    for (let i = 0; i < ordersLength; i++) {
                        orders[i] = await orderFactory.newSignedOrderAsync({});
                    }

                    // Subscribe to orders and wait for order events.
                    const orderEvents = deployment.client.onOrderEvents();
                    orderEvents.subscribe({
                        error: err => {
                            throw err;
                        },
                        next: (events: OrderEvent[]) => {
                            expect(events.length).to.be.eq(orders.length);
                            for (const orderEvent of events) {
                                expect(orderEvent.endState).to.be.eq(OrderEventEndState.Added);
                                const now = new Date().getUTCMilliseconds();
                                // tslint:disable-next-line:custom-no-magic-numbers
                                assertRoughlyEquals(now, orderEvent.timestampMs, secondsToMs(10));
                            }

                            // Ensure that all of the orders that were added had an associated order event emitted.
                            for (const order of orders) {
                                const orderHash = orderHashUtils.getOrderHashHex(order);
                                let hasSeenMatch = false;
                                for (const event of events) {
                                    if (orderHash === event.order.hash) {
                                        hasSeenMatch = true;
                                        const expectedOrder = {
                                            ...order,
                                            hash: orderHash,
                                            fillableTakerAssetAmount: order.takerAssetAmount,
                                        };
                                        expect(event.order).to.be.deep.eq(expectedOrder);
                                        break;
                                    }
                                }
                                expect(hasSeenMatch).to.be.true();
                            }
                            done();
                        },
                    });
                    const validationResults = await deployment.client.addOrdersAsync(orders);
                    expect(validationResults.accepted.length).to.be.eq(ordersLength);
                })().catch(done);
            });

            it('should receive subscription updates about cancelled orders', (done: DoneCallback) => {
                (async () => {
                    // Add an order and then cancel it.
                    const order = await orderFactory.newSignedOrderAsync({});
                    const validationResults = await deployment.client.addOrdersAsync([order]);
                    expect(validationResults.accepted.length).to.be.eq(1);

                    // Subscribe to order events and assert that only a single cancel event was received.
                    const orderEvents = deployment.client.onOrderEvents();
                    orderEvents.subscribe({
                        error: err => {
                            throw err;
                        },
                        next: (events: OrderEvent[]) => {
                            // Ensure that the correct cancel event was logged.
                            expect(events.length).to.be.eq(1);
                            const [orderEvent] = events;
                            expect(orderEvent.endState).to.be.eq(OrderEventEndState.Cancelled);
                            const expectedOrder = {
                                ...order,
                                hash: orderHashUtils.getOrderHashHex(order),
                                fillableTakerAssetAmount: constants.ZERO_AMOUNT,
                            };
                            expect(orderEvent.order).to.be.deep.eq(expectedOrder);
                            const now = new Date().getUTCMilliseconds();
                            assertRoughlyEquals(orderEvent.timestampMs, now, secondsToMs(2));
                            expect(orderEvent.contractEvents.length).to.be.eq(1);

                            // Ensure that the contract event is correct.
                            const [contractEvent] = orderEvent.contractEvents;
                            expect(contractEvent.address).to.be.eq(exchangeAddress);
                            expect(contractEvent.kind).to.be.equal('ExchangeCancelEvent');
                            expect(contractEvent.logIndex).to.be.eq(0);
                            expect(contractEvent.isRemoved).to.be.false();
                            expect(contractEvent.txIndex).to.be.eq(0);
                            const hashLength = 66;
                            expect(contractEvent.blockHash.length).to.be.eq(hashLength);
                            expect(contractEvent.blockHash).to.not.be.eq(constants.NULL_BYTES32);
                            expect(contractEvent.txHash.length).to.be.eq(hashLength);
                            const parameters = contractEvent.parameters;
                            parameters.makerAddress = parameters.makerAddress.toLowerCase();
                            parameters.senderAddress = parameters.makerAddress;
                            expect(parameters.feeRecipientAddress.toLowerCase()).to.be.eq(order.feeRecipientAddress);
                            expect(parameters.makerAddress.toLowerCase()).to.be.eq(makerAddress);
                            expect(parameters.makerAssetData).to.be.eq(order.makerAssetData);
                            expect(parameters.orderHash).to.be.eq(orderHashUtils.getOrderHashHex(order));
                            expect(parameters.senderAddress.toLowerCase()).to.be.eq(makerAddress);
                            expect(parameters.takerAssetData).to.be.eq(order.takerAssetData);
                            done();
                        },
                    });

                    // Cancel an order and then wait for the emitted order event.
                    // tslint:disable-next-line: await-promise
                    await exchange.cancelOrder(order).awaitTransactionSuccessAsync({ from: makerAddress });
                })().catch(done);
            });
        });
    });

    // describe('unit tests', () => {
    //     describe('#onClose', () => {
    //         it('should trigger when connection is closed', (done: DoneCallback) => {
    //             // tslint:disable-next-line:no-floating-promises
    //             (async () => {
    //                 const wsServer = await setupServerAsync();
    //                 wsServer.on('connect', async (connection: WebSocket.connection) => {
    //                     // tslint:disable-next-line:custom-no-magic-numbers
    //                     await sleepAsync(100);
    //                     connection.close();
    //                 });

    //                 const client = new WSClient(`ws://localhost:${SERVER_PORT}`);
    //                 client.onClose(() => {
    //                     client.destroy();
    //                     stopServer();
    //                     done();
    //                 });
    //             })().catch(done);
    //         });
    //     });
    //     describe('#onReconnected', async () => {
    //         it('should trigger the callback when reconnected', (done: DoneCallback) => {
    //             // tslint:disable-next-line:no-floating-promises
    //             (async () => {
    //                 const wsServer = await setupServerAsync();
    //                 let connectionNum = 0;
    //                 wsServer.on('connect', async (connection: WebSocket.connection) => {
    //                     let requestNum = 0;
    //                     connectionNum++;
    //                     connection.on('message', (async (message: WSMessage) => {
    //                         const jsonRpcRequest = JSON.parse(message.utf8Data);
    //                         if (requestNum === 0) {
    //                             const response = `
    //                                 {
    //                                     "id": "${jsonRpcRequest.id}",
    //                                     "jsonrpc": "2.0",
    //                                     "result": "0xab1a3e8af590364c09d0fa6a12103ada"
    //                                 }
    //                             `;
    //                             connection.sendUTF(response);
    //                             if (connectionNum === 1) {
    //                                 // tslint:disable-next-line:custom-no-magic-numbers
    //                                 await sleepAsync(100);
    //                                 const reasonCode = WebSocket.connection.CLOSE_REASON_PROTOCOL_ERROR;
    //                                 const description = (WebSocket.connection as any).CLOSE_DESCRIPTIONS[reasonCode];
    //                                 connection.drop(reasonCode, description);
    //                             }
    //                         }
    //                         requestNum++;
    //                     }) as any);
    //                 });

    //                 const client = new WSClient(`ws://localhost:${SERVER_PORT}`, { reconnectDelay: 100 });
    //                 client.onReconnected(async () => {
    //                     // We need to add a sleep here so that we leave time for the client
    //                     // to get connected before destroying it.
    //                     // tslint:disable-next-line:custom-no-magic-numbers
    //                     await sleepAsync(100);
    //                     client.destroy();
    //                     stopServer();
    //                     done();
    //                 });
    //             })().catch(done);
    //         });
    //     });
    //     describe('#destroy', async () => {
    //         it('should unsubscribe and trigger onClose when close() is called', (done: DoneCallback) => {
    //             // tslint:disable-next-line:no-floating-promises
    //             (async () => {
    //                 const wsServer = await setupServerAsync();
    //                 let hasReceivedUnsubscribeMessage = false;
    //                 wsServer.on('connect', (connection: WebSocket.connection) => {
    //                     connection.on('message', async (message: WebSocket.IMessage) => {
    //                         const wsMessage = message as WSMessage;
    //                         const jsonRpcRequest = JSON.parse(wsMessage.utf8Data);
    //                         if (jsonRpcRequest.method === 'mesh_subscribe') {
    //                             const response = `
    //                                 {
    //                                     "id": "${jsonRpcRequest.id}",
    //                                     "jsonrpc": "2.0",
    //                                     "result": "0xab1a3e8af590364c09d0fa6a12103ada"
    //                                 }
    //                             `;
    //                             connection.sendUTF(response);
    //                         } else if (jsonRpcRequest.method === 'mesh_unsubscribe') {
    //                             hasReceivedUnsubscribeMessage = true;
    //                         }
    //                     });
    //                 });

    //                 const client = new WSClient(`ws://localhost:${SERVER_PORT}`);
    //                 client.onClose(() => {
    //                     expect(hasReceivedUnsubscribeMessage).to.be.equal(true);
    //                     done();
    //                 });
    //                 // We need to add a sleep here so that we leave time for the client
    //                 // to get connected before destroying it.
    //                 // tslint:disable-next-line:custom-no-magic-numbers
    //                 await sleepAsync(100);
    //                 client.destroy();
    //             })().catch(done);
    //         });
    //     });
});

function assertRoughlyEquals(a: number, b: number, delta: number): void {
    expect(Math.abs(a - b)).to.be.lessThan(delta);
}

function leftPad(a: number, paddingDigits: number = 2): string {
    return `${'0'.repeat(paddingDigits - a.toString().length)}${a.toString()}`;
}

function secondsToMs(seconds: number): number {
    const msPerSecond = 1000;
    return seconds * msPerSecond;
}

// Verify that all of the orders that were added to the mesh node
// were returned in the `getOrders` rpc response
// function expectContainsOrders(expectedOrders: SignedOrder[], ordersInfos: OrderInfo[]): void {
//     for (const order of expectedOrders) {
//         let hasSeenMatch = false;
//         for (const responseOrder of ordersInfos) {
//             if (orderHashUtils.getOrderHashHex(order) === responseOrder.orderHash) {
//                 hasSeenMatch = true;
//                 expect(order).to.be.deep.eq(responseOrder.signedOrder);
//                 break;
//             }
//         }
//         expect(hasSeenMatch).to.be.true();
//     }
// }
// tslint:disable-line:max-file-line-count
