package blockwatch

import (
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/0xProject/0x-mesh/meshdb"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

type filterLogsResponse struct {
	Logs []types.Log
	Err  error
}

// fakeLogClient is a fake Client for testing purposes.
type fakeLogClient struct {
	count           int
	rangeToResponse map[string]filterLogsResponse
	Mu              sync.Mutex
}

// newFakeLogClient instantiates a fakeLogClient for testing log fetching
func newFakeLogClient(rangeToResponse map[string]filterLogsResponse) (*fakeLogClient, error) {
	return &fakeLogClient{count: 0, rangeToResponse: rangeToResponse}, nil
}

// HeaderByNumber fetches a block header by its number
func (fc *fakeLogClient) HeaderByNumber(number *big.Int) (*meshdb.MiniHeader, error) {
	return nil, errors.New("NOT_IMPLEMENTED")
}

// HeaderByHash fetches a block header by its block hash
func (fc *fakeLogClient) HeaderByHash(hash common.Hash) (*meshdb.MiniHeader, error) {
	return nil, errors.New("NOT_IMPLEMENTED")
}

// FilterLogs returns the logs that satisfy the supplied filter query
func (fc *fakeLogClient) FilterLogs(q ethereum.FilterQuery) ([]types.Log, error) {
	fc.Mu.Lock()
	defer fc.Mu.Unlock()
	// Add a slight delay to simulate an actual network request. This also gives
	// BlockWatcher.getLogsInBlockRange multi-requests to hit the concurrent request
	// limit semaphore and simulate more realistic conditions.
	<-time.Tick(5 * time.Millisecond)
	res := fc.rangeToResponse[toRange(q.FromBlock, q.ToBlock)]
	fc.count = fc.count + 1
	return res.Logs, res.Err
}

func toRange(from, to *big.Int) string {
	r := fmt.Sprintf("%s-%s", from, to)
	return r
}

func toR(from, to int) string {
	r := fmt.Sprintf("%d-%d", from, to)
	return r
}
