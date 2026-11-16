import { Account, assert, BoxMap, clone, Contract, GlobalState, Txn, uint64 } from '@algorandfoundation/algorand-typescript'

/**
 * Educational demo only. Addresses and votes are public on-chain.
 *
 * Port of the original Solidity `Voting` contract. Algorand has no dynamic
 * state arrays or mappings, so per-candidate records and per-voter flags live
 * in box storage, paid for by the app account (fund it at deploy time).
 */
export type Candidate = {
  name: string
  votes: uint64
}

export type VoterStatus = {
  registered: boolean
  voted: boolean
}

export class Voting extends Contract {
  admin = GlobalState<Account>({ key: 'admin' })
  electionStarted = GlobalState<boolean>({ key: 'started' })
  electionEnded = GlobalState<boolean>({ key: 'ended' })
  candidateCount = GlobalState<uint64>({ key: 'count' })

  candidates = BoxMap<uint64, Candidate>({ keyPrefix: 'c' })
  voters = BoxMap<Account, VoterStatus>({ keyPrefix: 'v' })

  public constructor() {
    super()
    this.admin.value = Txn.sender
    // Algorand has no implicit defaults: reading an unset global key fails, so
    // every key the contract reads gets written at create time.
    this.electionStarted.value = false
    this.electionEnded.value = false
    this.candidateCount.value = 0
  }

  /** Registers the candidates. Runs once, right after deploy (boxes need the app account funded). */
  public initialize(names: string[]): void {
    this.onlyAdmin()
    assert(this.candidateCount.value === 0, 'Already initialized')
    assert(names.length > 0, 'Empty candidates list')
    assert(names.length >= 2, 'Need at least two candidates')

    for (let i: uint64 = 0; i < names.length; i += 1) {
      assert(names[i] !== '', 'Empty candidate name')
      this.candidates(i).value = { name: names[i], votes: 0 }
    }
    this.candidateCount.value = names.length
  }

  public registerVoter(voter: Account): void {
    this.onlyAdmin()
    assert(!this.electionStarted.value, 'Election already started')

    const status = this.getVoterStatus(voter)
    assert(!status.registered, 'Already registered')

    this.voters(voter).value = { registered: true, voted: status.voted }
  }

  public startElection(): void {
    this.onlyAdmin()
    assert(!this.electionStarted.value && !this.electionEnded.value, 'Cannot start')
    this.electionStarted.value = true
  }

  public vote(candidateId: uint64): void {
    assert(this.electionStarted.value && !this.electionEnded.value, 'Election not open')

    const status = this.getVoterStatus(Txn.sender)
    assert(status.registered, 'Wallet not registered')
    assert(!status.voted, 'Already voted')
    assert(candidateId < this.candidateCount.value, 'Invalid candidate')

    const candidate = clone(this.candidates(candidateId).value)
    this.candidates(candidateId).value = { name: candidate.name, votes: candidate.votes + 1 }
    this.voters(Txn.sender).value = { registered: true, voted: true }
  }

  public endElection(): void {
    this.onlyAdmin()
    assert(this.electionStarted.value && !this.electionEnded.value, 'Cannot end')
    this.electionEnded.value = true
  }

  public getCandidates(): Candidate[] {
    const result: Candidate[] = []
    for (let i: uint64 = 0; i < this.candidateCount.value; i += 1) {
      result.push(this.candidates(i).value)
    }
    return result
  }

  public getVoterStatus(voter: Account): VoterStatus {
    return this.voters(voter).get({ default: { registered: false, voted: false } })
  }

  private onlyAdmin(): void {
    assert(Txn.sender === this.admin.value, 'Only admin')
  }
}
