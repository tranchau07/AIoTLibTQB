package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.Role;
import com.example.AIoTLibTQB.document.User;
import com.example.AIoTLibTQB.dto.request.UserCreationRequest;
import com.example.AIoTLibTQB.dto.request.UserStatusRequest;
import com.example.AIoTLibTQB.dto.request.UserUpdateRequest;
import com.example.AIoTLibTQB.dto.response.PageResponse;
import com.example.AIoTLibTQB.dto.response.UserResponse;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.mapper.UserMapper;
import com.example.AIoTLibTQB.repository.RoleRepository;
import com.example.AIoTLibTQB.repository.UserRepository;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.security.access.prepost.PostAuthorize;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.util.HashSet;
import java.util.List;

@Service
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class UserService {

    UserRepository userRepository;
    UserMapper userMapper;
    PasswordEncoder passwordEncoder;
    RoleRepository roleRepository;

    public UserResponse create(UserCreationRequest request) {
        if (userRepository.existsByUsername(request.getUsername())) {
            throw new AppException(ErrorCode.USER_EXISTED);
        }

        User user = userMapper.toUser(request);
        user.setPassword(passwordEncoder.encode(request.getPassword()));

        Role defaultRole = roleRepository.findById(com.example.AIoTLibTQB.enums.Role.USER.name())
                .orElseThrow(() -> new AppException(ErrorCode.ROLE_NOT_EXISTED));
        user.setRoles(new HashSet<>(List.of(defaultRole)));

        boolean isAdmin = SecurityContextHolder.getContext().getAuthentication() != null &&
                SecurityContextHolder.getContext().getAuthentication().getAuthorities().stream()
                        .anyMatch(a -> "ADMIN".equals(a.getAuthority()) || "ROLE_ADMIN".equals(a.getAuthority()));
        if (!isAdmin) {
            user.setAssignedZones(new HashSet<>());
        }

        return userMapper.toUserResponse(userRepository.save(user));
    }

    public UserResponse getMyInfo() {
        String username = SecurityContextHolder.getContext().getAuthentication().getName();
        User user = userRepository.findByUsername(username)
                .orElseThrow(() -> new AppException(ErrorCode.USER_DID_NOT_EXIST));
        return userMapper.toUserResponse(user);
    }

    @PreAuthorize("hasAuthority('ADMIN')")
    public PageResponse<UserResponse> getAll(Pageable pageable) {
        Page<User> page = userRepository.findAll(pageable);
        List<UserResponse> content = userMapper.toUserResponses(page.getContent());
        return PageResponse.<UserResponse>builder()
                .content(content)
                .page(page.getNumber())
                .size(page.getSize())
                .totalElements(page.getTotalElements())
                .totalPages(page.getTotalPages())
                .last(page.isLast())
                .build();
    }

    @PostAuthorize("hasAuthority('ADMIN') or returnObject.username == authentication.name")
    public UserResponse getByID(String id) {
        User user = userRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.USER_DID_NOT_EXIST));
        return userMapper.toUserResponse(user);
    }

    @PostAuthorize("hasAuthority('ADMIN') or returnObject.username == authentication.name")
    public UserResponse update(UserUpdateRequest request, String id) {
        User user = userRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.USER_DID_NOT_EXIST));

        userMapper.updateUser(user, request);

        if (request.getPassword() != null && !request.getPassword().isBlank()) {
            user.setPassword(passwordEncoder.encode(request.getPassword()));
        }

        boolean isAdmin = SecurityContextHolder.getContext().getAuthentication() != null &&
                SecurityContextHolder.getContext().getAuthentication().getAuthorities().stream()
                        .anyMatch(a -> "ADMIN".equals(a.getAuthority()) || "ROLE_ADMIN".equals(a.getAuthority()));

        if (isAdmin) {
            if (request.getRoles() != null) {
                List<Role> roles = roleRepository.findAllById(request.getRoles());
                user.setRoles(new HashSet<>(roles));
            }
            if (request.getAssignedZones() != null) {
                user.setAssignedZones(new HashSet<>(request.getAssignedZones()));
            }
        }

        return userMapper.toUserResponse(userRepository.save(user));
    }

    @PreAuthorize("hasAuthority('ADMIN')")
    public UserResponse toggleStatus(String id, UserStatusRequest request) {
        User user = userRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.USER_DID_NOT_EXIST));
        user.setActive(request.isActive());
        return userMapper.toUserResponse(userRepository.save(user));
    }

    @PreAuthorize("hasAuthority('ADMIN')")
    public void deleteById(String id) {
        userRepository.deleteById(id);
    }
}
