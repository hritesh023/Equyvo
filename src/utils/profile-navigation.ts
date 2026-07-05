import { useNavigate, type NavigateFunction } from 'react-router-dom';

interface User {
  id?: string;
  userId?: string;
  uid?: string;
  user_id?: string;
  username?: string;
  handle?: string;
  name?: string;
}

export const navigateToProfile = (navigate: NavigateFunction, userId?: string, username?: string) => {
  if (userId) {
    navigate(`/profile/${userId}`);
    return;
  }
  
  if (username) {
    navigate(`/profile/@${username.replace('@', '')}`);
    return;
  }
  
  navigate('/profile');
};

export const getProfileUrl = (userId?: string, username?: string) => {
  if (userId) {
    return `/profile/${userId}`;
  }
  
  if (username) {
    return `/profile/@${username.replace('@', '')}`;
  }
  
  return '/profile';
};

export const getUserId = (user: User) => {
  return user?.id || user?.userId || user?.uid || user?.user_id;
};

export const getUsername = (user: User) => {
  return user?.username || user?.handle || user?.name?.toLowerCase().replace(/\s+/g, '-');
};
