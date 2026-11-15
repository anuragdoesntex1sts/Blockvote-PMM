import algosdk from 'algosdk'
import spec from './artifacts/Voting.arc56.json' with { type: 'json' }
const T = 'a'.repeat(64)
const algod = new algosdk.Algodv2(T, 'http://127.0.0.1', '4001')
const acct = algosdk.mnemonicToSecretKey('awake exclude domain welcome turkey april rural bracket desk stairs maple roof luxury multiply pitch address agree submit degree cage then furnace engage absent sick')
const b64 = (v) => Uint8Array.from(Buffer.from(v, 'base64'))
const send = async (txn, label) => {
  const { txId } = await algod.sendRawTransaction(txn.signTxn(acct.sk)).do()
  const p = await algosdk.waitForConfirmation(algod, txId, 8)
  console.log(label, 'ok round', p.confirmedRound ?? p['confirmed-round'])
  return p
}
let sp = await algod.getTransactionParams().do()
const created = await send(algosdk.makeApplicationCreateTxnFromObject({
  sender: acct.addr, suggestedParams: sp, onComplete: algosdk.OnApplicationComplete.NoOpOC,
  approvalProgram: b64(spec.byteCode.approval), clearProgram: b64(spec.byteCode.clear),
  numGlobalInts: spec.state.schema.global.ints, numGlobalByteSlices: spec.state.schema.global.bytes,
  numLocalInts: 0, numLocalByteSlices: 0,
}), 'create')
const appId = created.applicationIndex
console.log('APP ID', appId)
sp = await algod.getTransactionParams().do()
await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: acct.addr, receiver: algosdk.getApplicationAddress(appId), amount: 2_000_000n, suggestedParams: sp,
}), 'fund')
sp = await algod.getTransactionParams().do()
await send(algosdk.makeApplicationNoOpTxnFromObject({
  sender: acct.addr, appIndex: appId,
  appArgs: [algosdk.ABIMethod.fromSignature('initialize(string[])void').getSelector(), algosdk.ABIType.from('string[]').encode(['Alice','Bob','Carol'])],
  suggestedParams: sp,
}), 'initialize')
const box = await algod.getApplicationBoxByName(appId, new TextEncoder().encode('candidates')).do()
console.log('candidates box bytes:', box.value.length)
const state = await algod.getApplicationByID(appId).do()
console.log('global state:', JSON.stringify(state.params.globalState))
