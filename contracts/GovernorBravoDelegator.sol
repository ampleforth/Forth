// SPDX-License-Identifier: BSD-3-Clause

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "./GovernorBravoInterfaces.sol";

contract GovernorBravoDelegator is GovernorBravoDelegatorStorage, GovernorBravoEvents {
    constructor(
                address timelock_,
                address forth_,
                address admin_,
	        address implementation_,
	        uint votingPeriod_,
	        uint votingDelay_,
                uint proposalThreshold_) public {

        // Admin set to msg.sender for initialization
        admin = msg.sender;

        delegateTo(implementation_, abi.encodeWithSignature("initialize(address,address,uint256,uint256,uint256)",
                                                            timelock_,
                                                            forth_,
                                                            votingPeriod_,
                                                            votingDelay_,
                                                            proposalThreshold_));

        _setImplementation(implementation_);

        admin = admin_;
    }


    /**
     * @notice Called by the admin to update the implementation of the delegator
     * @param implementation_ The address of the new implementation for delegation
     */
    function _setImplementation(address implementation_) public {
        require(msg.sender == admin, "GovernorBravoDelegator::_setImplementation: admin only");
        require(implementation_ != address(0), "GovernorBravoDelegator::_setImplementation: invalid implementation address");

        address oldImplementation = implementation;
        implementation = implementation_;

        emit NewImplementation(oldImplementation, implementation);
    }

    /**
     * @notice Internal method to delegate execution to another contract
     * @dev It returns to the external caller whatever the implementation returns or forwards reverts
     * @param callee The contract to delegatecall
     * @param data The raw data to delegatecall
     */
    function delegateTo(address callee, bytes memory data) internal {
        (bool success, bytes memory returnData) = callee.delegatecall(data);
        assembly {
            if eq(success, 0) {
                    revert(add(returnData, 0x20), returndatasize())
            }
        }
    }

    /**
     * @dev Delegates the current call to implementation.
     *
     * This function does not return to its internall call site, it will return directly to the external caller.
     */
    function _fallback() internal {
        // delegate all other functions to current implementation
        (bool success, ) = implementation.delegatecall(msg.data);

        assembly {
            let free_mem_ptr := mload(0x40)
                returndatacopy(free_mem_ptr, 0, returndatasize())

                switch success
                    case 0 { revert(free_mem_ptr, returndatasize()) }
            default { return(free_mem_ptr, returndatasize()) }
        }
    }

    /**
     * @dev Delegates execution to an implementation contract.
     * It returns to the external caller whatever the implementation returns or forwards reverts.
     */
    fallback() external payable {
        _fallback();
    }

    /**
     * @dev Fallback function that delegates calls to implementation. Will run if call data is empty.
     */
    receive() external payable {
        _fallback();
    }
}
