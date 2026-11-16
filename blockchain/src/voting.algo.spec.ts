import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { describe, expect, it } from 'vitest'
import { Voting } from './voting.algo'

describe('Voting contract', () => {
  const ctx = new TestExecutionContext()

  it('registers candidates on initialize', () => {
    const contract = ctx.contract.create(Voting)

    contract.initialize(['Alice', 'Bob'])

    expect(contract.getCandidates().map((c) => ({ name: c.name, votes: Number(c.votes) }))).toEqual([
      { name: 'Alice', votes: 0 },
      { name: 'Bob', votes: 0 },
    ])
  })

  it('rejects fewer than two candidates and empty names', () => {
    const contract = ctx.contract.create(Voting)

    expect(() => contract.initialize(['Alice'])).toThrow(/Need at least two candidates/)
    expect(() => contract.initialize([])).toThrow(/Empty candidates list/)
    expect(() => contract.initialize(['Alice', ''])).toThrow(/Empty candidate name/)
  })

  it('only registers a voter once, and never after the election starts', () => {
    const contract = ctx.contract.create(Voting)
    const voter = ctx.any.account()

    contract.initialize(['Alice', 'Bob'])
    contract.registerVoter(voter)
    expect(contract.getVoterStatus(voter).registered).toBe(true)

    expect(() => contract.registerVoter(voter)).toThrow(/Already registered/)

    contract.startElection()
    expect(() => contract.registerVoter(ctx.any.account())).toThrow(/Election already started/)
  })

  it('counts one vote per registered voter', () => {
    const contract = ctx.contract.create(Voting)
    const alice = ctx.any.account()
    const bob = ctx.any.account()

    contract.initialize(['Alice', 'Bob'])
    contract.registerVoter(alice)
    contract.registerVoter(bob)
    contract.startElection()

    for (const voter of [alice, bob]) {
      ctx.txn.createScope([ctx.any.txn.applicationCall({ sender: voter })]).execute(() => contract.vote(0))
    }

    expect(contract.getCandidates().map((c) => Number(c.votes))).toEqual([2, 0])
    expect(contract.getVoterStatus(alice).voted).toBe(true)
  })

  it('rejects votes before the election opens', () => {
    const contract = ctx.contract.create(Voting)
    const voter = ctx.any.account()

    contract.initialize(['Alice', 'Bob'])
    contract.registerVoter(voter)

    ctx.txn.createScope([ctx.any.txn.applicationCall({ sender: voter })]).execute(() => {
      expect(() => contract.vote(0)).toThrow(/Election not open/)
    })
  })

  it('rejects unregistered wallets, bad candidate ids, and double votes', () => {
    const contract = ctx.contract.create(Voting)
    const voter = ctx.any.account()
    const stranger = ctx.any.account()

    contract.initialize(['Alice', 'Bob'])
    contract.registerVoter(voter)
    contract.startElection()

    ctx.txn.createScope([ctx.any.txn.applicationCall({ sender: stranger })]).execute(() => {
      expect(() => contract.vote(0)).toThrow(/Wallet not registered/)
    })

    ctx.txn.createScope([ctx.any.txn.applicationCall({ sender: voter })]).execute(() => {
      expect(() => contract.vote(5)).toThrow(/Invalid candidate/)
      contract.vote(1)
      expect(() => contract.vote(1)).toThrow(/Already voted/)
    })
  })

  it('stops accepting votes after the election ends', () => {
    const contract = ctx.contract.create(Voting)
    const voter = ctx.any.account()

    contract.initialize(['Alice', 'Bob'])
    contract.registerVoter(voter)
    contract.startElection()
    contract.endElection()

    ctx.txn.createScope([ctx.any.txn.applicationCall({ sender: voter })]).execute(() => {
      expect(() => contract.vote(0)).toThrow(/Election not open/)
    })
  })

  it('only lets the admin start and end the election', () => {
    const contract = ctx.contract.create(Voting)
    const stranger = ctx.any.account()

    contract.initialize(['Alice', 'Bob'])

    ctx.txn.createScope([ctx.any.txn.applicationCall({ sender: stranger })]).execute(() => {
      expect(() => contract.startElection()).toThrow(/Only admin/)
    })
  })
})
