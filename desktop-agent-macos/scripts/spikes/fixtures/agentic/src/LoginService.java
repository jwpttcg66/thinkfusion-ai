package com.acme.login;

public class LoginService {
    private final UserRepository userRepository;
    private final AuthToken authToken;

    public LoginService(UserRepository userRepository, AuthToken authToken) {
        this.userRepository = userRepository;
        this.authToken = authToken;
    }

    public LoginResult login(String email, String password) {
        User user = userRepository.findByEmail(email);
        if (user == null || !user.matches(password)) {
            return LoginResult.rejected("invalid credentials");
        }
        String token = authToken.issue(user.id());
        return LoginResult.ok(token);
    }
}
