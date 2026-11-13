package com.acme.login;

public class LoginController {
    private final LoginService loginService;

    public LoginController(LoginService loginService) {
        this.loginService = loginService;
    }

    public LoginResult login(LoginRequest request) {
        return loginService.login(request.email(), request.password());
    }
}
