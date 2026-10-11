package token

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestMemorySpentTokenStoreNewReplayConflict(t *testing.T) {
	store := NewMemorySpentTokenStore()
	ctx := context.Background()
	tokenID := strings.Repeat("a", 2*BallotHashSize)
	ballotHash1 := strings.Repeat("b", 2*BallotHashSize)
	ballotHash2 := strings.Repeat("c", 2*BallotHashSize)

	result, err := store.MarkSpent(ctx, "election-1", tokenID, ballotHash1)
	if err != nil || result != SpendNew {
		t.Fatalf("first MarkSpent = (%v, %v), want (%v, nil)", result, err, SpendNew)
	}
	result, err = store.MarkSpent(ctx, "election-1", tokenID, ballotHash1)
	if err != nil || result != SpendReplay {
		t.Fatalf("identical retry = (%v, %v), want (%v, nil)", result, err, SpendReplay)
	}
	result, err = store.MarkSpent(ctx, "election-1", tokenID, ballotHash2)
	if err != nil || result != SpendConflict {
		t.Fatalf("different ballot retry = (%v, %v), want (%v, nil)", result, err, SpendConflict)
	}
	result, err = store.MarkSpent(ctx, "election-2", tokenID, ballotHash1)
	if err != nil || result != SpendConflict {
		t.Fatalf("cross-election token reuse = (%v, %v), want (%v, nil)", result, err, SpendConflict)
	}
}

func TestMemorySpentTokenStoreConcurrentSameToken(t *testing.T) {
	const workers = 128
	store := NewMemorySpentTokenStore()
	tokenID := strings.Repeat("a", 2*BallotHashSize)
	ballotHash := strings.Repeat("b", 2*BallotHashSize)
	var newCount atomic.Int32
	var replayCount atomic.Int32
	var errorCount atomic.Int32
	var wait sync.WaitGroup
	wait.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wait.Done()
			result, err := store.MarkSpent(context.Background(), "election-1", tokenID, ballotHash)
			if err != nil {
				errorCount.Add(1)
				return
			}
			switch result {
			case SpendNew:
				newCount.Add(1)
			case SpendReplay:
				replayCount.Add(1)
			default:
				errorCount.Add(1)
			}
		}()
	}
	wait.Wait()
	if got := newCount.Load(); got != 1 {
		t.Fatalf("new count = %d, want 1", got)
	}
	if got := replayCount.Load(); got != workers-1 {
		t.Fatalf("replay count = %d, want %d", got, workers-1)
	}
	if got := errorCount.Load(); got != 0 {
		t.Fatalf("unexpected errors = %d", got)
	}
}

func TestMemorySpentTokenStoreConcurrentConflictingBallots(t *testing.T) {
	const workers = 96
	store := NewMemorySpentTokenStore()
	tokenID := strings.Repeat("a", 2*BallotHashSize)
	ballotHashes := [2]string{strings.Repeat("b", 2*BallotHashSize), strings.Repeat("c", 2*BallotHashSize)}
	var newCount atomic.Int32
	var conflictCount atomic.Int32
	var wait sync.WaitGroup
	wait.Add(workers)
	for i := 0; i < workers; i++ {
		ballotHash := ballotHashes[i%len(ballotHashes)]
		go func() {
			defer wait.Done()
			result, err := store.MarkSpent(context.Background(), "election-1", tokenID, ballotHash)
			if err != nil {
				t.Errorf("MarkSpent: %v", err)
				return
			}
			switch result {
			case SpendNew:
				newCount.Add(1)
			case SpendConflict:
				conflictCount.Add(1)
			case SpendReplay:
				// Concurrent requests with the winning ballot are idempotent.
			default:
				t.Errorf("unexpected spend result %v", result)
			}
		}()
	}
	wait.Wait()
	if got := newCount.Load(); got != 1 {
		t.Fatalf("new count = %d, want 1", got)
	}
	if got := conflictCount.Load(); got == 0 {
		t.Fatal("expected conflicting requests to be rejected")
	}
}

func TestMemorySpentTokenStoreHonorsCanceledContext(t *testing.T) {
	store := NewMemorySpentTokenStore()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.MarkSpent(ctx, "election-1", strings.Repeat("a", 64), strings.Repeat("b", 64)); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled MarkSpent error = %v, want context.Canceled", err)
	}
}
