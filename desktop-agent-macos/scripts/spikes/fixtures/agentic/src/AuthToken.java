package com.acme.login;

public class AuthToken {
    public String issue(String userId) {
        return "token-" + userId;
    }
}
