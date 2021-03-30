import chai, { expect } from 'chai'
import { BigNumber, Contract, constants, utils } from 'ethers'
import { solidity, MockProvider, createFixtureLoader, deployContract } from 'ethereum-waffle'
import { ecsign } from 'ethereumjs-util'

import { governanceFixture } from './fixtures'
import { expandTo18Decimals, mineBlock } from './utils'

import Forth from '../build/Forth.json'

chai.use(solidity)

const DOMAIN_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')
)

const PERMIT_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)')
)

describe('Forth', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet, other0, other1] = provider.getWallets()
  const loadFixture = createFixtureLoader([wallet], provider)

  let forth: Contract
  beforeEach(async () => {
    const fixture = await loadFixture(governanceFixture)
    forth = fixture.forth
  })

  it('permit', async () => {
    const domainSeparator = utils.keccak256(
      utils.defaultAbiCoder.encode(
        ['bytes32', 'bytes32', 'uint256', 'address'],
        [DOMAIN_TYPEHASH, utils.keccak256(utils.toUtf8Bytes('Ampleforth Governance')), 1, forth.address]
      )
    )

    const owner = wallet.address
    const spender = other0.address
    const value = 123
    const nonce = await forth.nonces(wallet.address)
    const deadline = constants.MaxUint256
    const digest = utils.keccak256(
      utils.solidityPack(
        ['bytes1', 'bytes1', 'bytes32', 'bytes32'],
        [
          '0x19',
          '0x01',
          domainSeparator,
          utils.keccak256(
            utils.defaultAbiCoder.encode(
              ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'],
              [PERMIT_TYPEHASH, owner, spender, value, nonce, deadline]
            )
          ),
        ]
      )
    )

    const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

    await forth.permit(owner, spender, value, deadline, v, utils.hexlify(r), utils.hexlify(s))
    expect(await forth.allowance(owner, spender)).to.eq(value)
    expect(await forth.nonces(owner)).to.eq(1)

    await forth.connect(other0).transferFrom(owner, spender, value)
  })

  it('nested delegation', async () => {
    await forth.transfer(other0.address, expandTo18Decimals(1))
    await forth.transfer(other1.address, expandTo18Decimals(2))

    let currectVotes0 = await forth.getCurrentVotes(other0.address)
    let currectVotes1 = await forth.getCurrentVotes(other1.address)
    expect(currectVotes0).to.be.eq(0)
    expect(currectVotes1).to.be.eq(0)

    await forth.connect(other0).delegate(other1.address)
    currectVotes1 = await forth.getCurrentVotes(other1.address)
    expect(currectVotes1).to.be.eq(expandTo18Decimals(1))

    await forth.connect(other1).delegate(other1.address)
    currectVotes1 = await forth.getCurrentVotes(other1.address)
    expect(currectVotes1).to.be.eq(expandTo18Decimals(1).add(expandTo18Decimals(2)))

    await forth.connect(other1).delegate(wallet.address)
    currectVotes1 = await forth.getCurrentVotes(other1.address)
    expect(currectVotes1).to.be.eq(expandTo18Decimals(1))
  })

  it('mints', async () => {
    const { timestamp: now } = await provider.getBlock('latest')
    const forth = await deployContract(wallet, Forth, [wallet.address, wallet.address, now + 60 * 60])
    const supply = await forth.totalSupply()

    await expect(forth.mint(wallet.address, 1)).to.be.revertedWith('Forth::mint: minting not allowed yet')

    let timestamp = await forth.mintingAllowedAfter()
    await mineBlock(provider, timestamp.toString())

    await expect(forth.connect(other1).mint(other1.address, 1)).to.be.revertedWith(
      'Forth::mint: only the minter can mint'
    )
    await expect(forth.mint('0x0000000000000000000000000000000000000000', 1)).to.be.revertedWith(
      'Forth::mint: cannot transfer to the zero address'
    )

    // can mint up to 2%
    const mintCap = BigNumber.from(await forth.mintCap())
    const amount = supply.mul(mintCap).div(100)
    await forth.mint(wallet.address, amount)
    expect(await forth.balanceOf(wallet.address)).to.be.eq(supply.add(amount))

    timestamp = await forth.mintingAllowedAfter()
    await mineBlock(provider, timestamp.toString())
    // cannot mint 2.01%
    await expect(forth.mint(wallet.address, supply.mul(mintCap.add(1)))).to.be.revertedWith(
      'Forth::mint: exceeded mint cap'
    )
  })

  it('burn', async () => {
    const { timestamp: now } = await provider.getBlock('latest')
    const forth = await deployContract(wallet, Forth, [wallet.address, wallet.address, now + 60 * 60])
    const supply = await forth.totalSupply()

    // burn 0
    let balanceBefore = await forth.balanceOf(wallet.address)
    await forth.connect(wallet).burn(0)
    expect(await forth.balanceOf(wallet.address)).to.be.eq(balanceBefore)
    expect(await forth.totalSupply()).to.be.eq(supply)

    // burn non-zero
    await forth.connect(wallet).burn(1)
    expect(await forth.balanceOf(wallet.address)).to.be.eq(balanceBefore.sub(1))
    expect(await forth.totalSupply()).to.be.eq(supply.sub(1))

    // burn > totalSupply
    await expect(forth.connect(wallet).burn(supply + 2)).to.be.revertedWith('Forth::_burn: amount exceeds totalSupply')

    // burn > balance
    await forth.connect(wallet).transfer(other0.address, 100)
    balanceBefore = await forth.balanceOf(wallet.address)
    await expect(forth.connect(wallet).burn(balanceBefore.add(1))).to.be.revertedWith(
      'Forth::_burn: amount exceeds balance'
    )
  })

  it('burnFrom', async () => {
    const { timestamp: now } = await provider.getBlock('latest')
    const forth = await deployContract(wallet, Forth, [wallet.address, wallet.address, now + 60 * 60])
    const supply = await forth.totalSupply()

    // burn 0
    let balanceBefore = await forth.balanceOf(wallet.address)
    await forth.connect(other0).burnFrom(wallet.address, 0)
    expect(await forth.balanceOf(wallet.address)).to.be.eq(balanceBefore)
    expect(await forth.totalSupply()).to.be.eq(supply)

    // burn non-zero
    await forth.connect(wallet).approve(other0.address, 100)
    await forth.connect(other0).burnFrom(wallet.address, 1)
    expect(await forth.balanceOf(wallet.address)).to.be.eq(balanceBefore.sub(1))
    expect(await forth.totalSupply()).to.be.eq(supply.sub(1))

    // burn > approval
    balanceBefore = await forth.balanceOf(wallet.address)
    await forth.connect(wallet).approve(other0.address, 100)
    await expect(forth.connect(other0).burnFrom(wallet.address, 101)).to.be.revertedWith(
      'Forth::burnFrom: amount exceeds allowance'
    )

    // burn > totalSupply
    balanceBefore = await forth.balanceOf(wallet.address)
    await forth.connect(wallet).approve(other0.address, balanceBefore.add(1))
    await expect(forth.connect(other0).burnFrom(wallet.address, balanceBefore.add(1))).to.be.revertedWith(
      'Forth::_burn: amount exceeds totalSupply'
    )

    // burn > balance
    await forth.connect(wallet).transfer(other0.address, 100)
    balanceBefore = await forth.balanceOf(wallet.address)
    await forth.connect(wallet).approve(other0.address, balanceBefore.add(1))
    await expect(forth.connect(other0).burnFrom(wallet.address, balanceBefore.add(1))).to.be.revertedWith(
      'Forth::_burn: amount exceeds balance'
    )

    // Zero Address
    await expect(forth.connect(wallet).burnFrom('0x0000000000000000000000000000000000000000', 0)).to.be.revertedWith(
      'Forth::_burn: burn from the zero address'
    )
  })
})
