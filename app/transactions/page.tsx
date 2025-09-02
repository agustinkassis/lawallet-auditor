'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { Wallet, Loader2, Zap, Activity, ArrowLeftRight, ArrowDown, ArrowUp, Bitcoin } from 'lucide-react';

import { timeAgo } from '@/lib/utils';

// import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TableHeader, TableRow, TableHead, TableBody, TableCell, Table } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { LEDGER } from '@/config/constants';
import { NostrEvent, UserTransaction, transactionTypes } from '@/types';

export default function LaWalletAuditor() {
  const [relayUrl, setRelayUrl] = useState('wss://relay.lawallet.ar');
  const [isAuditing, setIsAuditing] = useState(false);
  // const [progress, setProgress] = useState(0);
  // const [totalEvents, setTotalEvents] = useState(0);
  const [processedEvents, setProcessedEvents] = useState(0);
  const [totalEventsProcessed, setTotalEventsProcessed] = useState(0);
  const [totalEventsDeduped, setTotalEventsDeduped] = useState(0);
  const [rounds, setRounds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  // Filters
  const [transactionFilter, setTransactionFilter] = useState<'all' | 'inbound' | 'outbound' | 'internal'>('all');

  // Balance
  const [totalBalance, setTotalBalance] = useState(0);

  // Transactions
  const [userTransactions, setUserTransactions] = useState<Map<string, UserTransaction>>(new Map());

  const filteredTransactions = useMemo(() => {
    if (!userTransactions) return [];
    return Array.from(userTransactions.values()).filter((tx) => {
      if (transactionFilter === 'all') return true;
      return tx.type.startsWith(transactionFilter);
    });
  }, [userTransactions, transactionFilter]);

  useEffect(() => {
    const savedTxs = localStorage.getItem('lawallet-auditor-transactions');
    if (savedTxs) {
      try {
        const parsed = JSON.parse(savedTxs);
        const transactionsMap = new Map<string, UserTransaction>();

        // Convert array back to Map
        parsed.forEach((transaction: UserTransaction) => {
          transactionsMap.set(transaction.id, transaction);
        });

        setUserTransactions(transactionsMap);

        // Calculate total balance
        const total = Array.from(transactionsMap.values()).reduce((sum, tx) => sum + tx.amount, 0);
        setTotalBalance(total);
        setTotalEventsDeduped(transactionsMap.size);
        setIsComplete(true);
      } catch (err) {
        // console.error('[v0] Error loading saved transactions:', err);
      }
    }
  }, []);

  useEffect(() => {
    if (userTransactions.size > 0) {
      const transactionsArray = Array.from(userTransactions.values());
      localStorage.setItem('lawallet-auditor-transactions', JSON.stringify(transactionsArray));
    }
  }, [userTransactions]);

  const generateSubscriptionId = () => Math.random().toString(36).substring(7);

  const parseNostrEvent = (
    event: NostrEvent,
  ): { id: string; pubkey: string; amount: number; type: string; error: boolean } | null => {
    console.log('event', event);
    try {
      const tTag = event.tags.find((tag) => tag[0] === 't');
      if (!tTag) return null;

      const pTag = event.tags.find((tag) => tag[0] === 'p');
      if (!pTag) return null;

      const eTag = event.tags.find((tag) => tag[0] === 'e');
      if (!eTag) return null;

      // Find the amount tag
      const { tokens } = JSON.parse(event?.content);
      if (!tokens?.BTC || tokens?.BTC === 0) return null;

      const parseAmount = Number.parseInt(tokens?.BTC);
      if (isNaN(parseAmount)) return null;

      const amountInMiliSats = Math.floor(parseAmount / 1000);

      return {
        id: eTag[1],
        pubkey: pTag[1],
        amount: amountInMiliSats,
        type: tTag[1].split('-')[0],
        error: tTag[1].split('-')[2] === 'error',
      };
    } catch (err) {
      // console.error('Error parsing event:', err);
      return null;
    }
  };

  const startAudit = useCallback(async () => {
    if (!relayUrl.trim()) {
      setError('Please enter a valid relay URL');
      return;
    }

    setIsAuditing(true);
    setError(null);
    // setProgress(0);
    setProcessedEvents(0);
    // setTotalEvents(0);
    setTotalEventsProcessed(0);
    setRounds(0);
    setIsComplete(false);

    try {
      const ws = new WebSocket(relayUrl);
      const transactions = new Map(userTransactions);

      let allEvents: NostrEvent[] = [];
      let until: number | undefined;
      let hasMore = true;
      let currentRound = 0;
      let totalProcessed = 0;

      ws.onopen = () => {
        // console.log('[v0] Connected to relay:', relayUrl);
        // Start the first query
        queryEvents();
      };

      const queryEvents = () => {
        currentRound++;
        setRounds(currentRound);

        const subscriptionId = generateSubscriptionId();
        const filter: any = {
          kinds: [1112 as number],
          authors: [LEDGER],
          '#t': transactionTypes,
          limit: 500,
        };

        if (until) {
          filter.until = until;
        }

        const request = JSON.stringify(['REQ', subscriptionId, filter]);
        // console.log('[v0] Sending request:', request);
        ws.send(request);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const [type, _, eventData] = data;

          if (type === 'EVENT' && eventData) {
            allEvents.push(eventData);
            totalProcessed++;
            setTotalEventsProcessed(totalProcessed);

            // Parse the event
            const parsed = parseNostrEvent(eventData);

            if (parsed) {
              const existing = transactions.get(parsed.id);
              if (!existing || eventData.created_at > existing.lastUpdated) {
                console.log('totalProcessed', totalProcessed);
                transactions.set(parsed.id, {
                  id: parsed?.id,
                  pubkey: parsed.pubkey,
                  amount: parsed.amount,
                  lastUpdated: eventData.created_at,
                  type: parsed?.type,
                  error: parsed?.error,
                });
              }
            }

            // Update progress
            setProcessedEvents(allEvents.length);
            setUserTransactions(new Map(transactions));
            setTotalEventsDeduped(transactions.size);

            // Calculate total amount
            const total = Array.from(transactions.values()).reduce((sum, user) => sum + user.amount, 0);
            setTotalBalance(total);
          } else if (type === 'EOSE') {
            // End of stored events for this subscription
            // console.log('[v0] Received EOSE, processed', allEvents.length, 'events in this batch');

            if (allEvents.length === 500) {
              // There might be more events, query with until parameter
              const oldestEvent = allEvents[allEvents.length - 1];
              until = oldestEvent.created_at - 1;
              allEvents = []; // Reset for next batch

              // Query next batch
              setTimeout(queryEvents, 100); // Small delay to avoid overwhelming the relay
            } else {
              // We've received all events
              hasMore = false;
              setIsComplete(true);
              // setProgress(100);
              ws.close();
            }
          }
        } catch (err) {
          // console.error('[v0] Error parsing message:', err);
        }
      };

      ws.onerror = (err) => {
        // console.error('[v0] WebSocket error:', err);
        setError('Failed to connect to relay. Please check the URL and try again.');
        setIsAuditing(false);
      };

      ws.onclose = () => {
        // console.log('[v0] WebSocket closed');
        setIsAuditing(false);
      };
    } catch (err) {
      console.error('[v0] Error starting audit:', err);
      setError('Failed to start audit. Please try again.');
      setIsAuditing(false);
    }
  }, [relayUrl]);

  const formatSats = (sats: number) => {
    return new Intl.NumberFormat().format(sats);
  };

  const formatBTC = (sats: number) => {
    return (sats / 100000000).toFixed(8);
  };

  return (
    <div className='min-h-screen bg-background p-4'>
      <div className='max-w-4xl mx-auto space-y-6'>
        <div className='text-center space-y-4 animate-slide-up'>
          <div className='flex items-center justify-center gap-3'>
            <div className='relative'>
              <Wallet className='h-10 w-10 text-accent' />
              <div className='absolute -top-1 -right-1'>
                <Zap className='h-4 w-4 text-secondary animate-bounce' />
              </div>
            </div>
            <h1 className='text-4xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent'>
              Transacciones
            </h1>
          </div>
          <p className='text-muted-foreground text-lg'>Validate transactions recorded on nostr relays</p>
          <div className='flex items-center justify-center gap-2 text-sm text-muted-foreground'>
            <Activity className='h-4 w-4' />
            <span>Real-time Bitcoin Lightning Network auditing</span>
          </div>
        </div>

        <Card className='bg-gradient-to-r from-primary/15 to-primary/0'>
          <CardHeader className='flex flex-row justify-between'>
            <div className='flex flex-col w-full'>
              <CardTitle className='flex items-center gap-2'>
                <Activity className='h-5 w-5 text-primary' />
                Relay Configuration
              </CardTitle>
              <CardDescription>Enter the nostr relay URL to audit user balances</CardDescription>
            </div>
            <Button
              onClick={startAudit}
              disabled={isAuditing || !relayUrl.trim()}
              className='min-w-[120px] bg-primary hover:bg-primary/90 transition-all duration-200 hover:scale-105 active:scale-95'
            >
              {isAuditing ? (
                <>
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                  Auditing...
                </>
              ) : (
                <>
                  <Zap className='mr-2 h-4 w-4' />
                  Start Audit
                </>
              )}
            </Button>
          </CardHeader>
          {isAuditing && (
            <CardContent className='space-y-4 pt-6'>
              <div className='flex gap-2'>
                {/* <Input
                placeholder='wss://relay.lawallet.ar'
                value={relayUrl}
                onChange={(e) => setRelayUrl(e.target.value)}
                disabled={isAuditing}
                className='flex-1 transition-all duration-200 focus:ring-2 focus:ring-primary/20 hover:border-primary/30'
              /> */}
              </div>

              <div className='grid grid-cols-2 gap-4'>
                <div className='space-y-2 p-3 bg-background rounded-lg'>
                  <div className='flex justify-between text-sm font-medium'>
                    <span>Events Processed</span>
                    <span className='text-accent font-mono'>{formatSats(processedEvents)}</span>
                  </div>
                </div>
                <div className='space-y-2 p-3 bg-background rounded-lg'>
                  <div className='flex justify-between text-sm font-medium'>
                    <span>Rounds (Iterations)</span>
                    <span className='text-primary font-mono'>{rounds}</span>
                  </div>
                </div>
                <div className='space-y-2 p-3 bg-background rounded-lg'>
                  <div className='flex justify-between text-sm font-medium'>
                    <span>Total Events Processed</span>
                    <span className='text-accent font-mono'>{totalEventsProcessed}</span>
                  </div>
                </div>
                <div className='space-y-2 p-3 bg-background rounded-lg'>
                  <div className='flex justify-between text-sm font-medium'>
                    <span>Total Events Deduplicated</span>
                    <span className='text-primary font-mono'>{totalEventsDeduped}</span>
                  </div>
                </div>
              </div>
              {!isComplete && (
                <div className='space-y-2'>
                  <p className='text-center text-sm text-muted-foreground animate-pulse'>Processing nostr events...</p>
                </div>
              )}

              {error && <div>{error}</div>}
            </CardContent>
          )}
        </Card>

        {userTransactions.size > 0 && (
          <div className='grid gap-4 md:grid-cols-1'>
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0'>
                <CardTitle className='text-sm font-medium'>Total Transactioned</CardTitle>
                <div className='relative'>
                  <Bitcoin className='size-4 text-muted-foreground' />
                </div>
              </CardHeader>
              <CardContent className='pt-4'>
                <div className='text-3xl font-bold font-mono'>{formatBTC(totalBalance)} BTC</div>
                <p className='text-sm text-muted-foreground font-mono'>{formatSats(totalBalance)} SAT</p>
              </CardContent>
            </Card>
          </div>
        )}

        {userTransactions.size > 0 && (
          <div className='flex justify-between items-center w-full'>
            <h2 className='text-lg font-bold'>Transactions ({userTransactions.size})</h2>
            <div className='flex items-center gap-4'>
              <Select value={transactionFilter} onValueChange={(value: any) => setTransactionFilter(value)}>
                <SelectTrigger className='w-[180px]'>
                  <SelectValue placeholder='Filtrar por tipo' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>All</SelectItem>
                  <SelectItem value='inbound'>Inbound</SelectItem>
                  <SelectItem value='internal'>Internal</SelectItem>
                  <SelectItem value='outbound'>Outbound</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {userTransactions.size > 0 && (
          <div className='grid gap-4 md:grid-cols-3'>
            <Card
              className={transactionFilter === 'all' || transactionFilter === 'inbound' ? 'opacity-100' : 'opacity-25'}
            >
              <CardHeader className='flex flex-row items-center justify-between space-y-0'>
                <CardTitle className='text-sm font-medium'>Inbound</CardTitle>
                <div className='relative'>
                  <ArrowDown className='size-4 text-muted-foreground' />
                </div>
              </CardHeader>
              <CardContent className='pt-4'>
                <div className='text-3xl font-bold font-mono'>
                  {Array.from(userTransactions.values()).filter((tx) => tx.type === 'inbound').length}
                </div>
                <p className='text-sm text-muted-foreground font-mono'>
                  {formatSats(
                    Array.from(userTransactions.values())
                      .filter((tx) => tx.type === 'inbound')
                      .reduce((sum, tx) => sum + tx.amount, 0),
                  )}{' '}
                  SAT
                </p>
              </CardContent>
            </Card>
            <Card
              className={transactionFilter === 'all' || transactionFilter === 'internal' ? 'opacity-100' : 'opacity-25'}
            >
              <CardHeader className='flex flex-row items-center justify-between space-y-0'>
                <CardTitle className='text-sm font-medium'>Internal</CardTitle>
                <div className='relative'>
                  <ArrowLeftRight className='size-4 text-muted-foreground' />
                </div>
              </CardHeader>
              <CardContent className='pt-4'>
                <div className='text-3xl font-bold font-mono'>
                  {Array.from(userTransactions.values()).filter((tx) => tx.type === 'internal').length}
                </div>
                <p className='text-sm text-muted-foreground font-mono'>
                  {formatSats(
                    Array.from(userTransactions.values())
                      .filter((tx) => tx.type === 'internal')
                      .reduce((sum, tx) => sum + tx.amount, 0),
                  )}{' '}
                  SAT
                </p>
              </CardContent>
            </Card>
            <Card
              className={transactionFilter === 'all' || transactionFilter === 'outbound' ? 'opacity-100' : 'opacity-25'}
            >
              <CardHeader className='flex flex-row items-center justify-between space-y-0'>
                <CardTitle className='text-sm font-medium'>Outbound</CardTitle>
                <div className='relative'>
                  <ArrowUp className='size-4 text-muted-foreground' />
                </div>
              </CardHeader>
              <CardContent className='pt-4'>
                <div className='text-3xl font-bold font-mono'>
                  {Array.from(userTransactions.values()).filter((tx) => tx.type === 'outbound').length}
                </div>
                <p className='text-sm text-muted-foreground font-mono'>
                  {formatSats(
                    Array.from(userTransactions.values())
                      .filter((tx) => tx.type === 'outbound')
                      .reduce((sum, tx) => sum + tx.amount, 0),
                  )}{' '}
                  SAT
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {filteredTransactions.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-4'></TableHead>
                <TableHead>Pubkey</TableHead>
                <TableHead>Ago</TableHead>
                <TableHead className='text-end'>Amount (SAT)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from(filteredTransactions.values())
                .sort((a, b) => b.amount - a.amount)
                .map((tx: UserTransaction) => (
                  <TableRow key={tx?.id}>
                    <TableCell className='w-4'>
                      <div className='flex items-center gap-2'>
                        {tx?.type === 'internal' && (
                          <ArrowLeftRight
                            className={`size-4 ${!tx?.error ? 'text-muted-foreground' : 'text-red-500'}`}
                          />
                        )}
                        {tx?.type === 'inbound' && (
                          <ArrowDown className={`size-4 ${!tx?.error ? 'text-muted-foreground' : 'text-red-500'}`} />
                        )}
                        {tx?.type === 'outbound' && (
                          <ArrowUp className={`size-4 ${!tx?.error ? 'text-muted-foreground' : 'text-red-500'}`} />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{tx?.pubkey}</TableCell>
                    <TableCell>{timeAgo(tx?.lastUpdated)}</TableCell>
                    <TableCell className='text-end'>{formatSats(tx?.amount)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
