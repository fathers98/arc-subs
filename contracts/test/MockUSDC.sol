// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test-only 6-decimals token that mimics the USDC ERC-20 interface.
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Token that tries to re-enter ArcSubs from inside transferFrom, to prove the guard works.
contract ReentrantUSDC is MockUSDC {
    address public target;
    uint256 public subIdToAttack;
    bool public reenterAttempted;
    bool public reenterSucceeded;

    function arm(address t, uint256 subId) external {
        target = t;
        subIdToAttack = subId;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (target != address(0)) {
            reenterAttempted = true;
            (bool ok, ) = target.call(abi.encodeWithSignature("charge(uint256)", subIdToAttack));
            if (ok) reenterSucceeded = true;
        }
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }
}
