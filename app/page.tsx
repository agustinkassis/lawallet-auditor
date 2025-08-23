"use client"

import { useState, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { AlertCircle, Wallet, Users, TrendingUp, Loader2, Zap, Activity, ExternalLink } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import Link from "next/link"

interface NostrEvent {
  id: string
  kind: number
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
  sig: string
}

interface UserBalance {
  pubkey: string
  balance: number
  lastUpdated: number
}

export default function LaWalletAuditor() {
  const [relayUrl, setRelayUrl] = useState("wss://relay.lawallet.ar")
  const [isAuditing, setIsAuditing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [totalEvents, setTotalEvents] = useState(0)
  const [processedEvents, setProcessedEvents] = useState(0)
  const [totalEventsProcessed, setTotalEventsProcessed] = useState(0)
  const [totalEventsDeduped, setTotalEventsDeduped] = useState(0)
  const [rounds, setRounds] = useState(0)
  const [userBalances, setUserBalances] = useState<Map<string, UserBalance>>(new Map())
  const [totalBalance, setTotalBalance] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isComplete, setIsComplete] = useState(false)

  useEffect(() => {
    const savedBalances = localStorage.getItem("lawallet-auditor-balances")
    if (savedBalances) {
      try {
        const parsed = JSON.parse(savedBalances)
        const balancesMap = new Map<string, UserBalance>()

        // Convert array back to Map
        parsed.forEach((balance: UserBalance) => {
          balancesMap.set(balance.pubkey, balance)
        })

        setUserBalances(balancesMap)

        // Calculate total balance
        const total = Array.from(balancesMap.values()).reduce((sum, user) => sum + user.balance, 0)
        setTotalBalance(total)
        setTotalEventsDeduped(balancesMap.size)
        setIsComplete(true)
      } catch (err) {
        console.error("[v0] Error loading saved balances:", err)
      }
    }
  }, [])

  useEffect(() => {
    if (userBalances.size > 0) {
      const balancesArray = Array.from(userBalances.values())
      localStorage.setItem("lawallet-auditor-balances", JSON.stringify(balancesArray))
    }
  }, [userBalances])

  const generateSubscriptionId = () => Math.random().toString(36).substring(7)

  const parseNostrEvent = (event: NostrEvent): { pubkey: string; balance: number } | null => {
    try {
      // Find the 'd' tag that contains the balance identifier
      const dTag = event.tags.find((tag) => tag[0] === "d" && tag[1]?.startsWith("balance:BTC:"))
      if (!dTag) return null

      // Extract pubkey from d tag: "balance:BTC:{pubkey}"
      const pubkey = dTag[1].split(":")[2]
      if (!pubkey) return null

      // Find the amount tag
      const amountTag = event.tags.find((tag) => tag[0] === "amount")
      if (!amountTag || !amountTag[1]) return null

      const balanceInMillisats = Number.parseInt(amountTag[1], 10)
      if (isNaN(balanceInMillisats)) return null

      const balance = Math.floor(balanceInMillisats / 1000)

      return { pubkey, balance }
    } catch (err) {
      console.error("Error parsing event:", err)
      return null
    }
  }

  const startAudit = useCallback(async () => {
    if (!relayUrl.trim()) {
      setError("Please enter a valid relay URL")
      return
    }

    setIsAuditing(true)
    setError(null)
    setProgress(0)
    setProcessedEvents(0)
    setTotalEvents(0)
    setTotalEventsProcessed(0)
    setRounds(0)
    setIsComplete(false)

    try {
      const ws = new WebSocket(relayUrl)
      const balances = new Map(userBalances)
      let allEvents: NostrEvent[] = []
      let until: number | undefined
      let hasMore = true
      let currentRound = 0
      let totalProcessed = 0

      ws.onopen = () => {
        console.log("[v0] Connected to relay:", relayUrl)
        // Start the first query
        queryEvents()
      }

      const queryEvents = () => {
        currentRound++
        setRounds(currentRound)

        const subscriptionId = generateSubscriptionId()
        const filter: any = {
          kinds: [31111],
          limit: 500,
        }

        if (until) {
          filter.until = until
        }

        const request = JSON.stringify(["REQ", subscriptionId, filter])
        console.log("[v0] Sending request:", request)
        ws.send(request)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          const [type, subscriptionId, eventData] = data

          if (type === "EVENT" && eventData) {
            allEvents.push(eventData)
            totalProcessed++
            setTotalEventsProcessed(totalProcessed)

            // Parse the event
            const parsed = parseNostrEvent(eventData)
            if (parsed) {
              const existing = balances.get(parsed.pubkey)
              if (!existing || eventData.created_at > existing.lastUpdated) {
                balances.set(parsed.pubkey, {
                  pubkey: parsed.pubkey,
                  balance: parsed.balance,
                  lastUpdated: eventData.created_at,
                })
              }
            }

            // Update progress
            setProcessedEvents(allEvents.length)
            setUserBalances(new Map(balances))
            setTotalEventsDeduped(balances.size)

            // Calculate total balance
            const total = Array.from(balances.values()).reduce((sum, user) => sum + user.balance, 0)
            setTotalBalance(total)
          } else if (type === "EOSE") {
            // End of stored events for this subscription
            console.log("[v0] Received EOSE, processed", allEvents.length, "events in this batch")

            if (allEvents.length === 500) {
              // There might be more events, query with until parameter
              const oldestEvent = allEvents[allEvents.length - 1]
              until = oldestEvent.created_at - 1
              allEvents = [] // Reset for next batch

              // Query next batch
              setTimeout(queryEvents, 100) // Small delay to avoid overwhelming the relay
            } else {
              // We've received all events
              hasMore = false
              setIsComplete(true)
              setProgress(100)
              ws.close()
            }
          }
        } catch (err) {
          console.error("[v0] Error parsing message:", err)
        }
      }

      ws.onerror = (err) => {
        console.error("[v0] WebSocket error:", err)
        setError("Failed to connect to relay. Please check the URL and try again.")
        setIsAuditing(false)
      }

      ws.onclose = () => {
        console.log("[v0] WebSocket closed")
        setIsAuditing(false)
      }
    } catch (err) {
      console.error("[v0] Error starting audit:", err)
      setError("Failed to start audit. Please try again.")
      setIsAuditing(false)
    }
  }, [relayUrl])

  const formatSats = (sats: number) => {
    return new Intl.NumberFormat().format(sats)
  }

  const formatBTC = (sats: number) => {
    return (sats / 100000000).toFixed(8)
  }

  return (
    <div className="min-h-screen gradient-bg p-4">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="text-center space-y-4 animate-slide-up">
          <div className="flex items-center justify-center gap-3">
            <div className="relative">
              <Wallet className="h-10 w-10 text-accent animate-pulse-glow" />
              <div className="absolute -top-1 -right-1">
                <Zap className="h-4 w-4 text-secondary animate-bounce" />
              </div>
            </div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              LaWallet Auditor
            </h1>
          </div>
          <p className="text-muted-foreground text-lg">Validate user balances recorded on nostr relays</p>
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Activity className="h-4 w-4" />
            <span>Real-time Bitcoin Lightning Network auditing</span>
          </div>
        </div>

        <Card className="animate-fade-in hover:shadow-lg transition-all duration-300 border-2 hover:border-primary/20">
          <CardHeader className="bg-gradient-to-r from-primary/5 to-accent/5 rounded-t-lg">
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              Relay Configuration
            </CardTitle>
            <CardDescription>Enter the nostr relay URL to audit user balances</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex gap-2">
              <Input
                placeholder="wss://relay.lawallet.ar"
                value={relayUrl}
                onChange={(e) => setRelayUrl(e.target.value)}
                disabled={isAuditing}
                className="flex-1 transition-all duration-200 focus:ring-2 focus:ring-primary/20 hover:border-primary/30"
              />
              <Button
                onClick={startAudit}
                disabled={isAuditing || !relayUrl.trim()}
                className="min-w-[120px] bg-primary hover:bg-primary/90 transition-all duration-200 hover:scale-105 active:scale-95"
              >
                {isAuditing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Auditing...
                  </>
                ) : (
                  <>
                    <Zap className="mr-2 h-4 w-4" />
                    Start Audit
                  </>
                )}
              </Button>
            </div>

            {error && (
              <Alert variant="destructive" className="animate-bounce-in">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {isAuditing && (
          <Card className="animate-slide-up border-2 border-accent/20 shadow-lg">
            <CardHeader className="bg-gradient-to-r from-accent/10 to-primary/10 rounded-t-lg">
              <CardTitle className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-accent" />
                Audit Progress
                <Badge variant="secondary" className="ml-auto animate-pulse">
                  Live
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2 p-3 bg-muted/30 rounded-lg">
                  <div className="flex justify-between text-sm font-medium">
                    <span>Events Processed</span>
                    <span className="text-accent font-mono">{formatSats(processedEvents)}</span>
                  </div>
                </div>
                <div className="space-y-2 p-3 bg-muted/30 rounded-lg">
                  <div className="flex justify-between text-sm font-medium">
                    <span>Rounds (Iterations)</span>
                    <span className="text-primary font-mono">{rounds}</span>
                  </div>
                </div>
                <div className="space-y-2 p-3 bg-muted/30 rounded-lg">
                  <div className="flex justify-between text-sm font-medium">
                    <span>Total Events Processed</span>
                    <span className="text-accent font-mono">{formatSats(totalEventsProcessed)}</span>
                  </div>
                </div>
                <div className="space-y-2 p-3 bg-muted/30 rounded-lg">
                  <div className="flex justify-between text-sm font-medium">
                    <span>Total Events Deduplicated</span>
                    <span className="text-primary font-mono">{formatSats(totalEventsDeduped)}</span>
                  </div>
                </div>
              </div>
              {!isComplete && (
                <div className="space-y-2">
                  <Progress value={undefined} className="w-full h-2" />
                  <p className="text-center text-sm text-muted-foreground animate-pulse">Processing nostr events...</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {userBalances.size > 0 && (
          <div className="grid gap-6 md:grid-cols-3">
            <Card className="animate-bounce-in hover:shadow-xl transition-all duration-300 hover:scale-105 border-2 border-accent/20">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 bg-gradient-to-br from-accent/10 to-accent/5 rounded-t-lg">
                <CardTitle className="text-sm font-medium">Total Balance</CardTitle>
                <div className="relative">
                  <TrendingUp className="h-5 w-5 text-accent animate-pulse-glow" />
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="text-3xl font-bold text-accent font-mono">{formatSats(totalBalance)} sats</div>
                <p className="text-sm text-muted-foreground font-mono">{formatBTC(totalBalance)} BTC</p>
              </CardContent>
            </Card>

            <Card
              className="animate-bounce-in hover:shadow-xl transition-all duration-300 hover:scale-105 border-2 border-primary/20"
              style={{ animationDelay: "0.1s" }}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 bg-gradient-to-br from-primary/10 to-primary/5 rounded-t-lg">
                <CardTitle className="text-sm font-medium">Total Users</CardTitle>
                <Users className="h-5 w-5 text-primary animate-pulse" />
              </CardHeader>
              <CardContent className="pt-4">
                <div className="text-3xl font-bold text-primary font-mono">{formatSats(userBalances.size)}</div>
                <p className="text-sm text-muted-foreground">Unique users found</p>
              </CardContent>
            </Card>

            <Card
              className="animate-bounce-in hover:shadow-xl transition-all duration-300 hover:scale-105 border-2 border-secondary/20"
              style={{ animationDelay: "0.2s" }}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 bg-gradient-to-br from-secondary/10 to-secondary/5 rounded-t-lg">
                <CardTitle className="text-sm font-medium">Status</CardTitle>
                <AlertCircle className="h-5 w-5 text-secondary" />
              </CardHeader>
              <CardContent className="pt-4">
                <div className="text-2xl font-bold">
                  <Badge
                    variant={isComplete ? "default" : "secondary"}
                    className={`${isComplete ? "bg-green-500 hover:bg-green-600" : "animate-pulse"} transition-all duration-200`}
                  >
                    {isComplete ? "Complete" : "Processing"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  {formatSats(totalEventsProcessed)} processed, {formatSats(totalEventsDeduped)} unique users
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {userBalances.size > 0 && (
          <Card className="animate-slide-up border-2 hover:border-primary/20 transition-all duration-300">
            <CardHeader className="bg-gradient-to-r from-primary/5 to-accent/5 rounded-t-lg">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                User Balances
              </CardTitle>
              <CardDescription>Individual user balances (showing latest balance per user)</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {Array.from(userBalances.values())
                  .sort((a, b) => b.balance - a.balance)
                  .map((user, index) => (
                    <Link key={user.pubkey} href={`/user/${user.pubkey}`} className="block">
                      <div
                        className="flex items-center justify-between p-4 rounded-lg border-2 border-muted hover:border-primary/30 transition-all duration-200 hover:shadow-md hover:scale-[1.02] bg-gradient-to-r from-card to-card/50 cursor-pointer group"
                        style={{ animationDelay: `${index * 0.05}s` }}
                      >
                        <div className="flex items-center gap-3">
                          <Badge
                            variant="outline"
                            className={`text-xs font-mono ${index < 3 ? "border-accent text-accent" : ""}`}
                          >
                            #{index + 1}
                          </Badge>
                          <code className="text-sm bg-muted/50 px-3 py-1 rounded-md font-mono border">
                            {user.pubkey.slice(0, 8)}...{user.pubkey.slice(-8)}
                          </code>
                          <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                        </div>
                        <div className="text-right">
                          <div className="font-mono text-sm font-bold text-accent">{formatSats(user.balance)} sats</div>
                          <div className="text-xs text-muted-foreground font-mono">{formatBTC(user.balance)} BTC</div>
                        </div>
                      </div>
                    </Link>
                  ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
